import { HeroUIProvider, Spinner, ToastProvider } from '@heroui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AnimatePresence } from 'motion/react'
import { MainLayout } from '@/components/layout/main-layout'
import { UpdateNotification } from '@/components/shared/update-notification'
import { AuthProvider, LoginPage, useAuthStore } from '@/features/auth'
import { CryptoProvider } from '@/features/crypto'
import { useAppUpdater } from '@/hooks/use-app-updater'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
      retry: 1,
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
