/**
 * Persists the user's preferred audio devices in localStorage so the next
 * session reuses them.
 *
 * WHY localStorage (not the preferences API): device IDs are hardware-specific
 * to this machine/browser — syncing them across devices via the server would
 * restore IDs that do not exist elsewhere. Storage access goes through the
 * shared safe helpers in @/lib/storage (one pattern per concern).
 */

import { readStorage, writeStorage } from '@/lib/storage'

const STORAGE_KEYS = {
  audioinput: 'voice_preferred_audio_input',
  audiooutput: 'voice_preferred_audio_output',
} as const

export type AudioDeviceKind = keyof typeof STORAGE_KEYS

export function loadPreferredDeviceId(kind: AudioDeviceKind): string | null {
  // WHY: readStorage returns null on storage failure (private mode, storage
  // disabled) — a missing preference is not an error, fall back to defaults.
  return readStorage(STORAGE_KEYS[kind])
}

export function savePreferredDeviceId(kind: AudioDeviceKind, deviceId: string): void {
  writeStorage(STORAGE_KEYS[kind], deviceId)
}

export function clearPreferredDeviceId(kind: AudioDeviceKind): void {
  writeStorage(STORAGE_KEYS[kind], null)
}
