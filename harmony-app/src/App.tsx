import { HeroUIProvider, Spinner, ToastProvider } from '@heroui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MainLayout } from '@/components/layout/main-layout'
import { FeatureErrorBoundary } from '@/components/shared/error-boundary'
import { UpdateNotification } from '@/components/shared/update-notification'
import { AuthProvider, DesktopAuthRedirect, LoginPage, useAuthStore } from '@/features/auth'
import { CryptoProvider } from '@/features/crypto'
import { useAppUpdater } from '@/hooks/use-app-updater'
import { useDockBadge } from '@/hooks/use-dock-badge'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { useFaviconBadge } from '@/hooks/use-favicon-badge'

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
  const { session, isLoading } = useAuthStore()
  // WHY: Defer the update check until after login so the update
  // notification never appears on the login page.
  const isLoggedIn = !isLoading && session !== null
  const update = useAppUpdater(isLoggedIn)

  if (isLoading) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background">
        <Spinner size="lg" color="primary" />
      </div>
    )
  }

  if (session === null) {
    return <LoginPage />
  }

  // WHY: When the browser is opened from Tauri with redirect_scheme=harmony
  // and the user is already logged in, show a confirmation screen to redirect
  // back to the desktop app instead of loading the full app.
  const isDesktopRedirect =
    new URLSearchParams(window.location.search).get('redirect_scheme') === 'harmony'
  if (isDesktopRedirect) {
    return <DesktopAuthRedirect />
  }

  // WHY: Inline narrowing so TypeScript knows updateInfo is non-null inside the JSX.
  const readyUpdate = update.status === 'ready' && !update.dismissed ? update.updateInfo : null

  return (
    <>
      <UnreadBadges />
      <MainLayout />
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
