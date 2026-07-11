import { create } from 'zustand'

export type UserSettingsTab = 'profile' | 'notifications'

interface SettingsUiState {
  showServerSettings: boolean
  /** WHY: User settings modal is global — opened from the gear button in
   *  BOTH sidebars (channel + DM), mounted once in MainLayout so it survives
   *  view switches (CLAUDE.md 4.6). Tabs: profile (identity P2) +
   *  notifications (T1.2). */
  showUserSettings: boolean
  userSettingsTab: UserSettingsTab
  openServerSettings: () => void
  closeServerSettings: () => void
  openUserSettings: (tab?: UserSettingsTab) => void
  closeUserSettings: () => void
  setUserSettingsTab: (tab: UserSettingsTab) => void
}

export const useSettingsUiStore = create<SettingsUiState>()((set) => ({
  showServerSettings: false,
  showUserSettings: false,
  userSettingsTab: 'profile',
  openServerSettings: () => {
    // WHY: Mutual exclusivity — only one full-screen view at a time. The
    // user-settings modal flag must also drop, or it reappears as a ghost when
    // the user leaves server settings (MainLayout early-returns unmount the
    // modal without clearing the flag).
    import('@/lib/about-ui-store').then(({ useAboutUiStore }) => {
      useAboutUiStore.getState().closeAboutPage()
    })
    import('@/lib/discovery-ui-store').then(({ useDiscoveryUiStore }) => {
      useDiscoveryUiStore.getState().closeDiscovery()
    })
    set({ showServerSettings: true, showUserSettings: false })
  },
  closeServerSettings: () => set({ showServerSettings: false }),
  openUserSettings: (tab) => {
    // WHY: Same mutual exclusivity in the other direction.
    import('@/lib/about-ui-store').then(({ useAboutUiStore }) => {
      useAboutUiStore.getState().closeAboutPage()
    })
    set({
      showUserSettings: true,
      showServerSettings: false,
      userSettingsTab: tab ?? 'profile',
    })
  },
  closeUserSettings: () => set({ showUserSettings: false }),
  setUserSettingsTab: (tab) => set({ userSettingsTab: tab }),
}))
