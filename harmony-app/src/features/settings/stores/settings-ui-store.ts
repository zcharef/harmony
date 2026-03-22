import { create } from 'zustand'

interface SettingsUiState {
  showServerSettings: boolean
  openServerSettings: () => void
  closeServerSettings: () => void
}

export const useSettingsUiStore = create<SettingsUiState>()((set) => ({
  showServerSettings: false,
  openServerSettings: () => set({ showServerSettings: true }),
  closeServerSettings: () => set({ showServerSettings: false }),
}))
