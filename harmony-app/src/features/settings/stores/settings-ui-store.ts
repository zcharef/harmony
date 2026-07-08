import { create } from 'zustand'

interface SettingsUiState {
  showServerSettings: boolean
  /** WHY: Profile settings modal is global — opened from the gear button in
   *  BOTH sidebars (channel + DM), mounted once in MainLayout so it survives
   *  view switches (CLAUDE.md 4.6). */
  showProfileSettings: boolean
  openServerSettings: () => void
  closeServerSettings: () => void
  openProfileSettings: () => void
  closeProfileSettings: () => void
}

export const useSettingsUiStore = create<SettingsUiState>()((set) => ({
  showServerSettings: false,
  showProfileSettings: false,
  openServerSettings: () => {
    // WHY: Mutual exclusivity — only one full-screen view at a time. The
    // profile modal flag must also drop, or it reappears as a ghost when the
    // user leaves server settings (MainLayout early-returns unmount the modal
    // without clearing the flag).
    import('@/lib/about-ui-store').then(({ useAboutUiStore }) => {
      useAboutUiStore.getState().closeAboutPage()
    })
    set({ showServerSettings: true, showProfileSettings: false })
  },
  closeServerSettings: () => set({ showServerSettings: false }),
  openProfileSettings: () => {
    // WHY: Same mutual exclusivity in the other direction.
    import('@/lib/about-ui-store').then(({ useAboutUiStore }) => {
      useAboutUiStore.getState().closeAboutPage()
    })
    set({ showProfileSettings: true, showServerSettings: false })
  },
  closeProfileSettings: () => set({ showProfileSettings: false }),
}))
