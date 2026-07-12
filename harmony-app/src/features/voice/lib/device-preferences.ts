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

/**
 * Persists the user's pre-call mute / deafen intent in localStorage.
 *
 * WHY the same layer as device IDs: self-mute/self-deafen is a persistent user
 * intent (Discord semantics — it survives leaving a call), and — like device
 * IDs — it is machine-local, so it belongs in localStorage rather than the
 * server preferences API. The voice store hydrates from these loaders at module
 * init and applies the intent to the LiveKit room on join.
 */
const AUDIO_STATE_KEYS = {
  muted: 'voice_preferred_muted',
  deafened: 'voice_preferred_deafened',
} as const

type AudioStateKind = keyof typeof AUDIO_STATE_KEYS

/** WHY: a missing preference falls back to the unmuted/undeafened default, so
 * only the literal string 'true' counts as on — any other value (null, legacy
 * junk) reads false. */
function loadAudioState(kind: AudioStateKind): boolean {
  return readStorage(AUDIO_STATE_KEYS[kind]) === 'true'
}

function saveAudioState(kind: AudioStateKind, value: boolean): void {
  writeStorage(AUDIO_STATE_KEYS[kind], value ? 'true' : 'false')
}

export function loadPreferredMuted(): boolean {
  return loadAudioState('muted')
}

export function savePreferredMuted(value: boolean): void {
  saveAudioState('muted', value)
}

export function loadPreferredDeafened(): boolean {
  return loadAudioState('deafened')
}

export function savePreferredDeafened(value: boolean): void {
  saveAudioState('deafened', value)
}
