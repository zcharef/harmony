import { HeroUIProvider, Spinner, ToastProvider } from '@heroui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MainLayout } from '@/components/layout/main-layout'
import { AuthProvider, LoginPage } from '@/features/auth'
import { useAuthStore } from '@/features/auth/stores/auth-store'

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

  return <MainLayout />
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <HeroUIProvider reducedMotion="user" disableRipple validationBehavior="aria">
        <main className="dark text-foreground bg-background">
          <AuthProvider>
            <AppContent />
          </AuthProvider>
        </main>
        <ToastProvider placement="bottom-right" toastOffset={16} />
      </HeroUIProvider>
    </QueryClientProvider>
  )
}

export default App
