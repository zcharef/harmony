import { HeroUIProvider, Spinner, ToastProvider } from '@heroui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AnimatePresence } from 'motion/react'
import { MainLayout } from '@/components/layout/main-layout'
import { UpdateNotification } from '@/components/shared/update-notification'
import { AuthProvider, DesktopAuthRedirect, LoginPage, useAuthStore } from '@/features/auth'
import { CryptoProvider } from '@/features/crypto'
import { useAppUpdater } from '@/hooks/use-app-updater'

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

function AppContent() {
  const { session, isLoading } = useAuthStore()
  // WHY: Gate on session !== null so the auto-relaunch on cold start doesn't
  // interrupt users on the login page with an unexplained restart.
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

  const updateVersion = update.status === 'ready' && !update.dismissed ? update.version : null

  return (
    <>
      <MainLayout />
      <AnimatePresence>
        {updateVersion !== null && (
          <UpdateNotification
            version={updateVersion}
            onRestart={update.restart}
            onDismiss={update.dismiss}
          />
        )}
      </AnimatePresence>
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
              <AppContent />
            </CryptoProvider>
          </AuthProvider>
        </main>
        <ToastProvider placement="bottom-right" toastOffset={16} />
      </HeroUIProvider>
    </QueryClientProvider>
  )
}

export default App
