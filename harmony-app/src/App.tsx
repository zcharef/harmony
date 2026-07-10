import { HeroUIProvider, Spinner, ToastProvider } from '@heroui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useCallback, useState } from 'react'
import { MainLayout } from '@/components/layout/main-layout'
import { FeatureErrorBoundary } from '@/components/shared/error-boundary'
import { UpdateNotification } from '@/components/shared/update-notification'
import {
  AuthProvider,
  DesktopAuthRedirect,
  LoginPage,
  ResetPasswordScreen,
  useAuthStore,
  VerifyEmailScreen,
} from '@/features/auth'
import { CryptoProvider } from '@/features/crypto'
import { InviteLandingPage } from '@/features/invite'
import { useAppUpdater } from '@/hooks/use-app-updater'
import { useDockBadge } from '@/hooks/use-dock-badge'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { useFaviconBadge } from '@/hooks/use-favicon-badge'
import { getInviteCodeFromPath } from '@/lib/invite-path'
import { ROUTES } from '@/lib/routes'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
      // WHY: 3 retries with exponential backoff (1s, 2s, 4s ≈ 7s total) before
      // queries enter error state. Balances "invisible retries" UX (ADR-045:
      // background ops fail silently) with time-to-error-feedback.
      retry: 3,
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 30000),
      refetchOnWindowFocus: false,
    },
  },
})

// WHY: Extracted into a component so hooks are only mounted after login.
// React hook rules forbid conditional calls, but conditional rendering of a
// component that calls hooks achieves the same effect. This matches the
// useAppUpdater(isLoggedIn) pattern — badge hooks should not set up canvas
// infrastructure or Tauri badge calls on the login page.
function UnreadBadges() {
  useDocumentTitle()
  useFaviconBadge()
  useDockBadge()
  return null
}

function AppContent() {
  const { session, user, isLoading, isPasswordRecovery } = useAuthStore()
  // WHY: Defer the update check until after login so the update
  // notification never appears on the login page.
  const isLoggedIn = !isLoading && session !== null
  const update = useAppUpdater(isLoggedIn)

  // WHY: /invite/:code is the only "route" rendered outside the main shell
  // (the app has no client-side router — ADR-033 constants + location checks).
  // `inviteResult` flips once the flow finishes so the shell can mount with
  // the joined server preselected.
  const inviteCode = getInviteCodeFromPath(window.location.pathname)
  const [inviteResult, setInviteResult] = useState<{ serverId: string | null } | null>(null)
  const isInviteFlow = inviteCode !== null && inviteResult === null

  // WHY useCallback: this is an effect dependency inside InviteLandingPage
  // (intent auto-join) — a fresh reference on every AppContent render would
  // re-run that effect needlessly.
  const handleInviteDone = useCallback((serverId: string | null) => {
    // WHY replaceState: leave /invite/:code without a reload and without
    // polluting history — Back must not re-trigger the join flow.
    window.history.replaceState(null, '', ROUTES.home())
    setInviteResult({ serverId })
  }, [])

  if (isLoading) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background">
        <Spinner size="lg" color="primary" />
      </div>
    )
  }

  // WHY before the LoginPage gate: the invitee must see server context
  // BEFORE being asked to sign up (invite-landing ticket). The page itself
  // escalates to LoginPage on "Accept invite".
  if (isInviteFlow && session === null) {
    return <InviteLandingPage code={inviteCode} onDone={handleInviteDone} />
  }

  if (session === null) {
    return <LoginPage />
  }

  // WHY: Defense-in-depth — if the user has a session but hasn't confirmed
  // their email, block access to the app. In production Supabase won't issue
  // sessions for unconfirmed users, but this catches local dev misconfig and
  // protects against Supabase-level bypasses. The backend API independently
  // returns 403 for unverified users on all routes except /v1/auth/me.
  if (user?.email_confirmed_at === undefined || user.email_confirmed_at === null) {
    return <VerifyEmailScreen email={user?.email ?? ''} />
  }

  // WHY: After clicking a password reset link, Supabase establishes a session
  // and fires PASSWORD_RECOVERY. This gate shows the new-password form before
  // the user reaches the main app.
  if (isPasswordRecovery) {
    return <ResetPasswordScreen />
  }

  // WHY: When the browser is opened from Tauri with redirect_scheme=harmony
  // and the user is already logged in, show a confirmation screen to redirect
  // back to the desktop app instead of loading the full app.
  const isDesktopRedirect =
    new URLSearchParams(window.location.search).get('redirect_scheme') === 'harmony'
  if (isDesktopRedirect) {
    return <DesktopAuthRedirect />
  }

  // WHY after email-confirm/password-recovery gates: an authed invitee must
  // still satisfy account safety gates before joining a server.
  if (isInviteFlow) {
    return <InviteLandingPage code={inviteCode} onDone={handleInviteDone} />
  }

  // WHY: Inline narrowing so TypeScript knows updateInfo is non-null inside the JSX.
  const readyUpdate = update.status === 'ready' && !update.dismissed ? update.updateInfo : null

  return (
    <>
      <UnreadBadges />
      <MainLayout initialServerId={inviteResult?.serverId ?? null} />
      {readyUpdate !== null && (
        <UpdateNotification
          version={readyUpdate.version}
          currentVersion={readyUpdate.currentVersion}
          body={readyUpdate.body}
          onRestart={update.restart}
          onDismiss={update.dismiss}
        />
      )}
    </>
  )
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <HeroUIProvider reducedMotion="user" disableRipple validationBehavior="aria">
        <main className="dark text-foreground bg-background">
          <AuthProvider>
            <CryptoProvider>
              <FeatureErrorBoundary name="AppContent">
                <AppContent />
              </FeatureErrorBoundary>
            </CryptoProvider>
          </AuthProvider>
        </main>
        <ToastProvider
          placement="bottom-right"
          toastOffset={16}
          toastProps={{
            classNames: {
              base: 'w-full sm:w-auto sm:max-w-md',
              title: 'whitespace-normal',
            },
          }}
        />
      </HeroUIProvider>
    </QueryClientProvider>
  )
}

export default App
