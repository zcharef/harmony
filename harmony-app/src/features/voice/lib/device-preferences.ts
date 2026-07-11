/**
 * Persists the user's preferred audio devices in localStorage so the next
 * session reuses them.
 *
 * WHY localStorage (not the preferences API): device IDs are hardware-specific
 * to this machine/browser — syncing them across devices via the server would
 * restore IDs that do not exist elsewhere. Follows the same direct-localStorage
 * pattern as crypto-store.ts (device ID persistence).
 */

import { logger } from '@/lib/logger'

const STORAGE_KEYS = {
  audioinput: 'voice_preferred_audio_input',
  audiooutput: 'voice_preferred_audio_output',
} as const

export type AudioDeviceKind = keyof typeof STORAGE_KEYS

export function loadPreferredDeviceId(kind: AudioDeviceKind): string | null {
  try {
    return localStorage.getItem(STORAGE_KEYS[kind])
  } catch (err: unknown) {
    // WHY: localStorage can throw (private mode, storage disabled). A missing
    // preference is not an error — fall back to system default silently.
    logger.warn('voice_device_preference_load_failed', {
      kind,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

export function savePreferredDeviceId(kind: AudioDeviceKind, deviceId: string): void {
  try {
    localStorage.setItem(STORAGE_KEYS[kind], deviceId)
  } catch (err: unknown) {
    logger.warn('voice_device_preference_save_failed', {
      kind,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function clearPreferredDeviceId(kind: AudioDeviceKind): void {
  try {
    localStorage.removeItem(STORAGE_KEYS[kind])
  } catch (err: unknown) {
    logger.warn('voice_device_preference_clear_failed', {
      kind,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
