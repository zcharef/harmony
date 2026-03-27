import { vi } from 'vitest'
import { useCryptoStore } from '@/features/crypto/stores/crypto-store'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

const initialState = useCryptoStore.getState()

beforeEach(() => {
  useCryptoStore.setState(initialState, true)
  localStorage.clear()
})

describe('useCryptoStore', () => {
  describe('initial state', () => {
    it('has isInitialized as false', () => {
      expect(useCryptoStore.getState().isInitialized).toBe(false)
    })

    it('has initFailed as false', () => {
      expect(useCryptoStore.getState().initFailed).toBe(false)
    })

    it('has an empty sessions map', () => {
      expect(useCryptoStore.getState().sessions).toBeInstanceOf(Map)
      expect(useCryptoStore.getState().sessions.size).toBe(0)
    })
  })

  describe('setInitialized', () => {
    it('sets isInitialized to true', () => {
      useCryptoStore.getState().setInitialized(true)

      expect(useCryptoStore.getState().isInitialized).toBe(true)
    })

    it('sets isInitialized back to false', () => {
      useCryptoStore.getState().setInitialized(true)
      useCryptoStore.getState().setInitialized(false)

      expect(useCryptoStore.getState().isInitialized).toBe(false)
    })
  })

  describe('setInitFailed', () => {
    it('sets initFailed to true', () => {
      useCryptoStore.getState().setInitFailed(true)

      expect(useCryptoStore.getState().initFailed).toBe(true)
    })

    it('sets initFailed back to false', () => {
      useCryptoStore.getState().setInitFailed(true)
      useCryptoStore.getState().setInitFailed(false)

      expect(useCryptoStore.getState().initFailed).toBe(false)
    })
  })

  describe('setDeviceId', () => {
    it('sets the deviceId in state', () => {
      useCryptoStore.getState().setDeviceId('device-123')

      expect(useCryptoStore.getState().deviceId).toBe('device-123')
    })

    it('persists deviceId to localStorage', () => {
      useCryptoStore.getState().setDeviceId('device-abc')

      expect(localStorage.getItem('harmony_device_id')).toBe('device-abc')
    })
  })

  describe('session management', () => {
    it('sets and gets a session for a recipient', () => {
      useCryptoStore.getState().setSession('user-1', 'session-abc')

      expect(useCryptoStore.getState().getSession('user-1')).toBe('session-abc')
    })

    it('returns undefined for an unknown recipient', () => {
      expect(useCryptoStore.getState().getSession('unknown')).toBeUndefined()
    })

    it('handles multiple sessions independently', () => {
      useCryptoStore.getState().setSession('user-1', 'session-1')
      useCryptoStore.getState().setSession('user-2', 'session-2')

      expect(useCryptoStore.getState().getSession('user-1')).toBe('session-1')
      expect(useCryptoStore.getState().getSession('user-2')).toBe('session-2')
    })

    it('overwrites an existing session for the same recipient', () => {
      useCryptoStore.getState().setSession('user-1', 'session-old')
      useCryptoStore.getState().setSession('user-1', 'session-new')

      expect(useCryptoStore.getState().getSession('user-1')).toBe('session-new')
    })
  })

  describe('identity key management', () => {
    it('sets and gets a known identity key', () => {
      useCryptoStore.getState().setKnownIdentityKey('user-1', 'key-abc')

      expect(useCryptoStore.getState().getKnownIdentityKey('user-1')).toBe('key-abc')
    })

    it('returns undefined for an unknown user', () => {
      expect(useCryptoStore.getState().getKnownIdentityKey('unknown')).toBeUndefined()
    })

    it('persists known identity keys to localStorage', () => {
      useCryptoStore.getState().setKnownIdentityKey('user-1', 'key-xyz')

      const stored = localStorage.getItem('harmony_known_identity_keys')
      expect(stored).not.toBeNull()
      const parsed = JSON.parse(stored!)
      expect(parsed).toContainEqual(['user-1', 'key-xyz'])
    })
  })

  describe('clear', () => {
    it('resets all state to defaults', () => {
      useCryptoStore.getState().setInitialized(true)
      useCryptoStore.getState().setInitFailed(true)
      useCryptoStore.getState().setDeviceId('device-123')
      useCryptoStore.getState().setSession('user-1', 'session-1')
      useCryptoStore.getState().setKnownIdentityKey('user-1', 'key-1')

      useCryptoStore.getState().clear()

      const state = useCryptoStore.getState()
      expect(state.isInitialized).toBe(false)
      expect(state.initFailed).toBe(false)
      expect(state.deviceId).toBeNull()
      expect(state.sessions.size).toBe(0)
      expect(state.knownIdentityKeys.size).toBe(0)
    })

    it('removes persisted data from localStorage', () => {
      useCryptoStore.getState().setDeviceId('device-123')
      useCryptoStore.getState().setKnownIdentityKey('user-1', 'key-1')

      useCryptoStore.getState().clear()

      expect(localStorage.getItem('harmony_device_id')).toBeNull()
      expect(localStorage.getItem('harmony_known_identity_keys')).toBeNull()
    })
  })
})
