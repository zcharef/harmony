import { vi } from 'vitest'
import { renderHook } from '@testing-library/react'

vi.mock('@/lib/api', () => ({
  getPreKeyBundle: vi.fn(),
}))

vi.mock('@/lib/crypto', () => ({
  createOutboundSession: vi.fn(),
  createInboundSession: vi.fn(),
}))

vi.mock('@/lib/platform', () => ({
  isTauri: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

const { getPreKeyBundle } = await import('@/lib/api')
const { createOutboundSession, createInboundSession } = await import('@/lib/crypto')
const { isTauri } = await import('@/lib/platform')
const { logger } = await import('@/lib/logger')

const { useCryptoStore } = await import('@/features/crypto/stores/crypto-store')
const { useCryptoSession } = await import('./use-crypto-session')

const cryptoInitialState = useCryptoStore.getState()

beforeEach(() => {
  vi.clearAllMocks()
  useCryptoStore.setState(cryptoInitialState, true)
})

describe('useCryptoSession', () => {
  describe('ensureSession', () => {
    it('throws when not running in Tauri', async () => {
      vi.mocked(isTauri).mockReturnValue(false)

      const { result } = renderHook(() => useCryptoSession())

      await expect(result.current.ensureSession('user-1')).rejects.toThrow(
        'E2EE sessions require desktop app',
      )
    })

    it('returns existing session without network call', async () => {
      vi.mocked(isTauri).mockReturnValue(true)
      useCryptoStore.getState().setSession('user-1', 'existing-session')

      const { result } = renderHook(() => useCryptoSession())

      const session = await result.current.ensureSession('user-1')

      expect(session).toEqual({ sessionId: 'existing-session', identityKeyChanged: false })
      expect(getPreKeyBundle).not.toHaveBeenCalled()
    })

    it('fetches pre-key bundle and creates outbound session when no session exists', async () => {
      vi.mocked(isTauri).mockReturnValue(true)
      vi.mocked(getPreKeyBundle).mockResolvedValueOnce({
        data: {
          identityKey: 'their-id-key',
          oneTimeKey: { keyId: 'otk-1', publicKey: 'otk-pub-1' },
          fallbackKey: null,
        },
      } as never)
      vi.mocked(createOutboundSession).mockResolvedValueOnce('new-session-id')

      const { result } = renderHook(() => useCryptoSession())

      const session = await result.current.ensureSession('user-1')

      expect(session.sessionId).toBe('new-session-id')
      expect(getPreKeyBundle).toHaveBeenCalledWith({
        path: { user_id: 'user-1' },
        throwOnError: true,
      })
      expect(createOutboundSession).toHaveBeenCalledWith('their-id-key', 'otk-pub-1')
      expect(useCryptoStore.getState().getSession('user-1')).toBe('new-session-id')
      expect(logger.info).toHaveBeenCalledWith('Outbound Olm session created', expect.any(Object))
    })

    it('falls back to fallback key when oneTimeKey is null', async () => {
      vi.mocked(isTauri).mockReturnValue(true)
      vi.mocked(getPreKeyBundle).mockResolvedValueOnce({
        data: {
          identityKey: 'their-id-key',
          oneTimeKey: null,
          fallbackKey: { keyId: 'fb-1', publicKey: 'fb-pub-1' },
        },
      } as never)
      vi.mocked(createOutboundSession).mockResolvedValueOnce('fb-session')

      const { result } = renderHook(() => useCryptoSession())

      const session = await result.current.ensureSession('user-1')

      expect(session.sessionId).toBe('fb-session')
      expect(createOutboundSession).toHaveBeenCalledWith('their-id-key', 'fb-pub-1')
    })

    it('throws when no pre-keys are available', async () => {
      vi.mocked(isTauri).mockReturnValue(true)
      vi.mocked(getPreKeyBundle).mockResolvedValueOnce({
        data: {
          identityKey: 'their-id-key',
          oneTimeKey: null,
          fallbackKey: null,
        },
      } as never)

      const { result } = renderHook(() => useCryptoSession())

      await expect(result.current.ensureSession('user-1')).rejects.toThrow(
        'No pre-keys available for user user-1',
      )
    })

    it('detects identity key change when stored key differs', async () => {
      vi.mocked(isTauri).mockReturnValue(true)
      // Store an old identity key
      useCryptoStore.getState().setKnownIdentityKey('user-1', 'old-key')

      vi.mocked(getPreKeyBundle).mockResolvedValueOnce({
        data: {
          identityKey: 'new-key',
          oneTimeKey: { keyId: 'otk-1', publicKey: 'otk-pub' },
          fallbackKey: null,
        },
      } as never)
      vi.mocked(createOutboundSession).mockResolvedValueOnce('new-session')

      const { result } = renderHook(() => useCryptoSession())

      const session = await result.current.ensureSession('user-1')

      expect(session.identityKeyChanged).toBe(true)
    })

    it('deduplicates concurrent ensureSession calls for the same recipient', async () => {
      vi.mocked(isTauri).mockReturnValue(true)
      vi.mocked(getPreKeyBundle).mockResolvedValueOnce({
        data: {
          identityKey: 'their-key',
          oneTimeKey: { keyId: 'otk-1', publicKey: 'otk-pub' },
          fallbackKey: null,
        },
      } as never)
      vi.mocked(createOutboundSession).mockResolvedValueOnce('session-1')

      const { result } = renderHook(() => useCryptoSession())

      const [s1, s2] = await Promise.all([
        result.current.ensureSession('user-1'),
        result.current.ensureSession('user-1'),
      ])

      // Both calls should resolve with the same session
      expect(s1.sessionId).toBe('session-1')
      expect(s2.sessionId).toBe('session-1')
      // Pre-key bundle should only be fetched once
      expect(getPreKeyBundle).toHaveBeenCalledOnce()
    })
  })

  describe('createInbound', () => {
    it('throws when not running in Tauri', async () => {
      vi.mocked(isTauri).mockReturnValue(false)

      const { result } = renderHook(() => useCryptoSession())

      await expect(
        result.current.createInbound('user-1', 'id-key', 'prekey-msg'),
      ).rejects.toThrow('E2EE sessions require desktop app')
    })

    it('creates an inbound session and stores it', async () => {
      vi.mocked(isTauri).mockReturnValue(true)
      vi.mocked(createInboundSession).mockResolvedValueOnce({
        session_id: 'inbound-session',
        plaintext: 'decrypted hello',
      })

      const { result } = renderHook(() => useCryptoSession())

      const inbound = await result.current.createInbound('user-1', 'sender-id-key', 'prekey-msg')

      expect(inbound.sessionId).toBe('inbound-session')
      expect(inbound.plaintext).toBe('decrypted hello')
      expect(inbound.identityKeyChanged).toBe(false)
      expect(createInboundSession).toHaveBeenCalledWith('sender-id-key', 'prekey-msg')
      expect(useCryptoStore.getState().getSession('user-1')).toBe('inbound-session')
      expect(useCryptoStore.getState().getKnownIdentityKey('user-1')).toBe('sender-id-key')
      expect(logger.info).toHaveBeenCalledWith('Inbound Olm session created', expect.any(Object))
    })

    it('detects identity key change on inbound session', async () => {
      vi.mocked(isTauri).mockReturnValue(true)
      useCryptoStore.getState().setKnownIdentityKey('user-1', 'old-sender-key')

      vi.mocked(createInboundSession).mockResolvedValueOnce({
        session_id: 'inbound-session',
        plaintext: 'hello',
      })

      const { result } = renderHook(() => useCryptoSession())

      const inbound = await result.current.createInbound('user-1', 'new-sender-key', 'prekey-msg')

      expect(inbound.identityKeyChanged).toBe(true)
    })
  })
})
