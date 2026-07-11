import { create } from 'zustand'
import { readStorage, writeStorage } from '@/lib/storage'

/**
 * Desktop-shell settings (Tauri only).
 *
 * WHY localStorage (not the preferences API): these are per-device shell
 * behaviors — syncing "close to tray" across machines makes no sense, same
 * reasoning as voice device-preferences.ts. Storage access goes through the
 * shared safe helpers in @/lib/storage (one pattern per concern).
 *
 * Autostart intentionally lives elsewhere: the OS launch-agent registry is
 * its source of truth, read/written via tauri-plugin-autostart
 * (use-autostart.ts) — mirroring it here would create a second SSoT.
 */

const CLOSE_TO_TRAY_KEY = 'desktop_close_to_tray'

interface DesktopSettingsState {
  /** WHY default ON: chat apps are expected to keep receiving messages and
   * calls after the window is closed (Discord/Slack parity). Real quit stays
   * one tray-menu click (or Cmd+Q) away. */
  closeToTray: boolean
  setCloseToTray: (enabled: boolean) => void
}

export const useDesktopSettingsStore = create<DesktopSettingsState>()((set) => ({
  closeToTray: readStorage(CLOSE_TO_TRAY_KEY) !== 'false',
  setCloseToTray: (enabled) => {
    writeStorage(CLOSE_TO_TRAY_KEY, enabled ? 'true' : 'false')
    set({ closeToTray: enabled })
  },
}))
