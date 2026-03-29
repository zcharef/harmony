import { create } from 'zustand'

interface AboutUiState {
  showAboutPage: boolean
  openAboutPage: () => void
  closeAboutPage: () => void
}

export const useAboutUiStore = create<AboutUiState>()((set) => ({
  showAboutPage: false,
  openAboutPage: () => {
    // WHY: Mutual exclusivity — only one full-screen view at a time.
    // Lazy import avoids circular dependency between stores.
    import('@/features/settings').then(({ useSettingsUiStore }) => {
      useSettingsUiStore.getState().closeServerSettings()
    })
    set({ showAboutPage: true })
  },
  closeAboutPage: () => set({ showAboutPage: false }),
}))
