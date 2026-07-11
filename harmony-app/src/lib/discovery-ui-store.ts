import { create } from 'zustand'

/**
 * WHY in lib (like about-ui-store): the discovery page is opened from the
 * server rail (server-nav feature) and rendered by MainLayout — a lib-level
 * store avoids a server-nav ↔ discovery feature import cycle.
 */
interface DiscoveryUiState {
  showDiscovery: boolean
  openDiscovery: () => void
  closeDiscovery: () => void
}

export const useDiscoveryUiStore = create<DiscoveryUiState>()((set) => ({
  showDiscovery: false,
  openDiscovery: () => {
    // WHY: Mutual exclusivity — only one full-screen view at a time.
    // Lazy imports avoid circular dependencies between stores.
    import('@/features/settings').then(({ useSettingsUiStore }) => {
      useSettingsUiStore.getState().closeServerSettings()
    })
    import('@/lib/about-ui-store').then(({ useAboutUiStore }) => {
      useAboutUiStore.getState().closeAboutPage()
    })
    set({ showDiscovery: true })
  },
  closeDiscovery: () => set({ showDiscovery: false }),
}))
