import { create } from 'zustand'

interface SettingsUiState {
  showServerSettings: boolean
  openServerSettings: () => void
  closeServerSettings: () => void
}

export const useSettingsUiStore = create<SettingsUiState>()((set) => ({
  showServerSettings: false,
  openServerSettings: () => {
    // WHY: Mutual exclusivity — only one full-screen view at a time.
    import('@/lib/about-ui-store').then(({ useAboutUiStore }) => {
      useAboutUiStore.getState().closeAboutPage()
    })
    set({ showServerSettings: true })
  },
  closeServerSettings: () => set({ showServerSettings: false }),
}))
