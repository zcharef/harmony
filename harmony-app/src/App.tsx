import { HeroUIProvider, Spinner, ToastProvider } from '@heroui/react'
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useCallback, useEffect, useState } from 'react'
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
import { openUpgradeModal, UpgradeModal } from '@/features/upgrade'
import { useAppUpdater } from '@/hooks/use-app-updater'
import { useDockBadge } from '@/hooks/use-dock-badge'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { useFaviconBadge } from '@/hooks/use-favicon-badge'
import { useSystemTray } from '@/hooks/use-system-tray'
import { getInviteCodeFromPath } from '@/lib/invite-path'
import { logger } from '@/lib/logger'
import { isTauri } from '@/lib/platform'
import { extractPlanGateError } from '@/lib/plan-gate'
import { ROUTES } from '@/lib/routes'

const queryClient = new QueryClient({
  // WHY a global MutationCache handler: FEATURE_NOT_IN_PLAN /
  // PLAN_LIMIT_REACHED can come from ANY plan-gated mutation (emoji upload,
  // invites, servers, channels, attachments…). Intercepting here opens the
  // UpgradeModal for every surface with ONE integration point; per-hook
  // onError toasts route through toastApiError, which stays silent for
  // these two codes so the modal is the only feedback (ADR-045).
  mutationCache: new MutationCache({
    onError: (error) => {
      const gate = extractPlanGateError(error)
      if (gate !== null) {
        openUpgradeModal(gate)
      }
    },
  }),
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
  // WHY here (not MainLayout): the tray and close-to-tray must exist on the
  // login screen too — AppContent never unmounts (CLAUDE.md 4.6).
  useSystemTray()

  // WHY: /invite/:code is the only "route" rendered outside the main shell
  // (the app has no client-side router — ADR-033 constants + location checks).
  // `inviteResult` flips once the flow finishes so the shell can mount with
  // the joined server preselected.
  // WHY deepLinkInviteCode state: harmony://invite/<code> deep links arrive
  // as events, not as the initial pathname — state is what re-renders the
  // shell into the invite flow when the desktop app is already running.
  const [deepLinkInviteCode, setDeepLinkInviteCode] = useState<string | null>(null)
  const [inviteResult, setInviteResult] = useState<{ serverId: string | null } | null>(null)
  const inviteCode = deepLinkInviteCode ?? getInviteCodeFromPath(window.location.pathname)
  const isInviteFlow = inviteCode !== null && inviteResult === null

  useEffect(() => {
    if (!isTauri()) return

    let cancelled = false
    let unlisten: (() => void) | undefined

    function handleInviteDeepLink(code: string) {
      // WHY reset inviteResult: a second invite link after a finished
      // flow must re-open the landing page, not be swallowed.
      setDeepLinkInviteCode(code)
      setInviteResult(null)
      // WHY: the window may be hidden in the tray — an invite click must
      // bring the app back (background op, log-only on failure).
      import('@tauri-apps/api/window')
        .then(({ getCurrentWindow }) => {
          const win = getCurrentWindow()
          return win.show().then(() => win.setFocus())
        })
        .catch((err: unknown) => {
          logger.warn('invite_deep_link_focus_failed', {
            error: err instanceof Error ? err.message : String(err),
          })
        })
    }

    async function setupInviteListener() {
      const { listenForInviteDeepLinks } = await import('@/features/invite')
      const stop = await listenForInviteDeepLinks(handleInviteDeepLink)
      if (cancelled) {
        stop()
      } else {
        unlisten = stop
      }
    }

    setupInviteListener().catch((err: unknown) => {
      logger.error('invite_deep_link_listener_setup_failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    })

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  // WHY useCallback: this is an effect dependency inside InviteLandingPage
  // (intent auto-join) — a fresh reference on every AppContent render would
  // re-run that effect needlessly.
  const handleInviteDone = useCallback((serverId: string | null) => {
    // WHY replaceState: leave /invite/:code without a reload and without
    // polluting history — Back must not re-trigger the join flow.
    window.history.replaceState(null, '', ROUTES.home())
    setDeepLinkInviteCode(null)
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
          <UpgradeModal />
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
