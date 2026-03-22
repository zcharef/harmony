/**
 * Crypto state store — manages E2EE device identity and Olm sessions.
 *
 * WHY Zustand: Device ID and session mappings are global ephemeral state
 * that multiple hooks need to read/write. Follows the same pattern as
 * presence-store.ts (src/features/presence/stores/presence-store.ts).
 *
 * WHY localStorage for deviceId: The device ID must survive page reloads
 * so the server-side device registration remains valid. Session IDs are
 * ephemeral (re-established from pre-key bundles when lost).
 */

import { create } from 'zustand'
import { logger } from '@/lib/logger'

const DEVICE_ID_KEY = 'harmony_device_id'
const KNOWN_IDENTITY_KEYS_KEY = 'harmony_known_identity_keys'

interface CryptoState {
  /** Whether crypto has been initialized for this session. */
  isInitialized: boolean
  /** Whether crypto initialization failed — used to warn user that DMs will be plaintext. */
  initFailed: boolean
  /** The local device ID (persisted in localStorage). */
  deviceId: string | null
  /** Active Olm session IDs keyed by recipient user ID. */
  sessions: Map<string, string>
  /** Known identity keys keyed by user ID (for key change detection). */
  knownIdentityKeys: Map<string, string>

  setInitialized: (initialized: boolean) => void
  setInitFailed: (failed: boolean) => void
  setDeviceId: (deviceId: string) => void
  setSession: (recipientUserId: string, sessionId: string) => void
  getSession: (recipientUserId: string) => string | undefined
  setKnownIdentityKey: (userId: string, identityKey: string) => void
  getKnownIdentityKey: (userId: string) => string | undefined
  clear: () => void
}

/** WHY: Load persisted known identity keys from localStorage. */
function loadKnownIdentityKeys(): Map<string, string> {
  try {
    const raw = localStorage.getItem(KNOWN_IDENTITY_KEYS_KEY)
    if (raw === null) return new Map()
    const entries: Array<[string, string]> = JSON.parse(raw)
    return new Map(entries)
  } catch (err: unknown) {
    logger.warn('load_known_identity_keys_failed', {
      error: err instanceof Error ? err.message : String(err),
    })
    return new Map()
  }
}

/** WHY: Load persisted device ID safely — avoids crash in test/SSR where localStorage is unavailable. */
function loadDeviceId(): string | null {
  try {
    return localStorage.getItem(DEVICE_ID_KEY)
  } catch {
    return null
  }
}

/** WHY: Persist known identity keys so key change detection works across restarts. */
function saveKnownIdentityKeys(map: Map<string, string>): void {
  localStorage.setItem(KNOWN_IDENTITY_KEYS_KEY, JSON.stringify(Array.from(map.entries())))
}

export const useCryptoStore = create<CryptoState>()((set, get) => ({
  isInitialized: false,
  initFailed: false,
  deviceId: loadDeviceId(),
  sessions: new Map(),
  knownIdentityKeys: loadKnownIdentityKeys(),

  setInitialized: (initialized) => set({ isInitialized: initialized }),
  setInitFailed: (failed) => set({ initFailed: failed }),

  setDeviceId: (deviceId) => {
    localStorage.setItem(DEVICE_ID_KEY, deviceId)
    set({ deviceId })
  },

  setSession: (recipientUserId, sessionId) =>
    set((state) => {
      const next = new Map(state.sessions)
      next.set(recipientUserId, sessionId)
      return { sessions: next }
    }),

  getSession: (recipientUserId) => get().sessions.get(recipientUserId),

  setKnownIdentityKey: (userId, identityKey) =>
    set((state) => {
      const next = new Map(state.knownIdentityKeys)
      next.set(userId, identityKey)
      saveKnownIdentityKeys(next)
      return { knownIdentityKeys: next }
    }),

  getKnownIdentityKey: (userId) => get().knownIdentityKeys.get(userId),

  clear: () => {
    localStorage.removeItem(DEVICE_ID_KEY)
    localStorage.removeItem(KNOWN_IDENTITY_KEYS_KEY)
    set({
      isInitialized: false,
      initFailed: false,
      deviceId: null,
      sessions: new Map(),
      knownIdentityKeys: new Map(),
    })
  },
}))
