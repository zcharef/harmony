import { HeroUIProvider } from '@heroui/react'
import { MainLayout } from '@/components/layout/main-layout'

function App() {
  return (
    <HeroUIProvider>
      <main className="dark text-foreground bg-background">
        <MainLayout />
      </main>
    </HeroUIProvider>
  )
}

export default App
