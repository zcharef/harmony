import { renderHook } from '@testing-library/react'
import { vi } from 'vitest'

vi.mock('@/lib/crypto', () => ({
  decrypt: vi.fn(),
}))

vi.mock('@/lib/crypto-cache', () => ({
  cacheMessage: vi.fn(),
  getCachedMessages: vi.fn(),
}))

vi.mock('@/lib/platform', () => ({
  isTauri: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

// WHY: Mock the crypto-queue to execute tasks immediately without queuing.
vi.mock('@/features/crypto/crypto-queue', () => ({
  enqueueForSession: vi.fn((_sessionId: string, task: () => Promise<unknown>) => task()),
}))

// WHY: Mock the session hook used internally by useEncryptedMessages.
vi.mock('./use-crypto-session', () => ({
  useCryptoSession: vi.fn(() => ({
    ensureSession: vi.fn(),
    createInbound: vi.fn(),
  })),
}))

const { decrypt } = await import('@/lib/crypto')
const { cacheMessage, getCachedMessages } = await import('@/lib/crypto-cache')
const { isTauri } = await import('@/lib/platform')
const { logger } = await import('@/lib/logger')
const { useCryptoSession } = await import('./use-crypto-session')

const { useCryptoStore } = await import('@/features/crypto/stores/crypto-store')
const { useEncryptedMessages } = await import('./use-encrypted-messages')

const cryptoInitialState = useCryptoStore.getState()

beforeEach(() => {
  vi.clearAllMocks()
  useCryptoStore.setState(cryptoInitialState, true)
})

function buildMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-1',
    channelId: 'ch-1',
    authorId: 'user-sender',
    authorUsername: 'alice',
    content: 'some content',
    createdAt: '2026-03-16T00:00:00.000Z',
    encrypted: false,
    ...overrides,
  }
}

describe('useEncryptedMessages', () => {
  describe('decryptMessage', () => {
    it('returns desktop_required error on web', async () => {
      vi.mocked(isTauri).mockReturnValue(false)

      const { result } = renderHook(() => useEncryptedMessages())
      const msg = buildMessage({ encrypted: true })

      const decrypted = await result.current.decryptMessage(msg as never)

      expect(decrypted).toEqual({
        plaintext: null,
        error: 'desktop_required',
        identityKeyChanged: false,
      })
    })

    it('returns plaintext directly for non-encrypted messages', async () => {
      vi.mocked(isTauri).mockReturnValue(true)

      const { result } = renderHook(() => useEncryptedMessages())
      const msg = buildMessage({ encrypted: false, content: 'plain hello' })

      const decrypted = await result.current.decryptMessage(msg as never)

      expect(decrypted).toEqual({
        plaintext: 'plain hello',
        error: null,
        identityKeyChanged: false,
      })
    })

    it('decrypts a normal (non-pre-key) message using existing session', async () => {
      vi.mocked(isTauri).mockReturnValue(true)
      useCryptoStore.getState().setSession('user-sender', 'session-abc')
      vi.mocked(decrypt).mockResolvedValueOnce('decrypted hello')
      vi.mocked(cacheMessage).mockResolvedValueOnce(undefined)

      const envelope = JSON.stringify({ message_type: 1, ciphertext: 'encrypted-data' })
      const msg = buildMessage({ encrypted: true, content: envelope })

      const { result } = renderHook(() => useEncryptedMessages())

      const decrypted = await result.current.decryptMessage(msg as never)

      expect(decrypted.plaintext).toBe('decrypted hello')
      expect(decrypted.error).toBeNull()
      expect(decrypt).toHaveBeenCalledWith('session-abc', 1, 'encrypted-data')
    })

    it('returns no_session error when no session exists for normal message', async () => {
      vi.mocked(isTauri).mockReturnValue(true)
      // No session set for user-sender

      const envelope = JSON.stringify({ message_type: 1, ciphertext: 'encrypted-data' })
      const msg = buildMessage({ encrypted: true, content: envelope })

      const { result } = renderHook(() => useEncryptedMessages())

      const decrypted = await result.current.decryptMessage(msg as never)

      expect(decrypted).toEqual({
        plaintext: null,
        error: 'no_session',
        identityKeyChanged: false,
      })
    })

    it('creates inbound session for pre-key messages (type 0)', async () => {
      vi.mocked(isTauri).mockReturnValue(true)

      const mockCreateInbound = vi.fn().mockResolvedValueOnce({
        sessionId: 'inbound-session',
        plaintext: 'first message',
        identityKeyChanged: false,
      })
      vi.mocked(useCryptoSession).mockReturnValueOnce({
        ensureSession: vi.fn(),
        createInbound: mockCreateInbound,
      })
      vi.mocked(cacheMessage).mockResolvedValueOnce(undefined)

      const envelope = JSON.stringify({ message_type: 0, ciphertext: 'pre-key-ciphertext' })
      const msg = buildMessage({ encrypted: true, content: envelope })

      const { result } = renderHook(() => useEncryptedMessages())

      const decrypted = await result.current.decryptMessage(msg as never, 'sender-id-key')

      expect(decrypted.plaintext).toBe('first message')
      expect(mockCreateInbound).toHaveBeenCalledWith(
        'user-sender',
        'sender-id-key',
        'pre-key-ciphertext',
      )
    })

    it('returns no_session for pre-key message without senderIdentityKey', async () => {
      vi.mocked(isTauri).mockReturnValue(true)

      const envelope = JSON.stringify({ message_type: 0, ciphertext: 'pre-key-data' })
      const msg = buildMessage({ encrypted: true, content: envelope })

      const { result } = renderHook(() => useEncryptedMessages())

      // No senderIdentityKey provided
      const decrypted = await result.current.decryptMessage(msg as never)

      expect(decrypted.plaintext).toBeNull()
      expect(logger.warn).toHaveBeenCalledWith(
        'pre_key_message_missing_identity_key',
        expect.any(Object),
      )
    })

    it('returns cached plaintext on second call', async () => {
      vi.mocked(isTauri).mockReturnValue(true)
      useCryptoStore.getState().setSession('user-sender', 'session-abc')
      vi.mocked(decrypt).mockResolvedValueOnce('decrypted hello')
      vi.mocked(cacheMessage).mockResolvedValueOnce(undefined)

      const envelope = JSON.stringify({ message_type: 1, ciphertext: 'enc' })
      const msg = buildMessage({ encrypted: true, content: envelope })

      const { result } = renderHook(() => useEncryptedMessages())

      await result.current.decryptMessage(msg as never)
      const second = await result.current.decryptMessage(msg as never)

      expect(second.plaintext).toBe('decrypted hello')
      expect(decrypt).toHaveBeenCalledOnce()
    })

    it('returns error result when decryption throws', async () => {
      vi.mocked(isTauri).mockReturnValue(true)
      useCryptoStore.getState().setSession('user-sender', 'session-abc')
      vi.mocked(decrypt).mockRejectedValueOnce(new Error('corrupt ratchet'))

      const envelope = JSON.stringify({ message_type: 1, ciphertext: 'bad' })
      const msg = buildMessage({ encrypted: true, content: envelope })

      const { result } = renderHook(() => useEncryptedMessages())

      const decrypted = await result.current.decryptMessage(msg as never)

      expect(decrypted).toEqual({
        plaintext: null,
        error: 'corrupt ratchet',
        identityKeyChanged: false,
      })
      expect(logger.error).toHaveBeenCalledWith(
        'Message decryption failed',
        expect.objectContaining({ messageId: 'msg-1' }),
      )
    })

    it('returns error for invalid envelope JSON', async () => {
      vi.mocked(isTauri).mockReturnValue(true)

      const msg = buildMessage({ encrypted: true, content: 'not-json' })

      const { result } = renderHook(() => useEncryptedMessages())

      const decrypted = await result.current.decryptMessage(msg as never)

      expect(decrypted.plaintext).toBeNull()
      expect(decrypted.error).toBeTruthy()
    })
  })

  describe('loadCachedDecryptions', () => {
    it('does nothing on web', async () => {
      vi.mocked(isTauri).mockReturnValue(false)

      const { result } = renderHook(() => useEncryptedMessages())

      await result.current.loadCachedDecryptions('ch-1')

      expect(getCachedMessages).not.toHaveBeenCalled()
    })

    it('loads cached messages into the in-memory cache', async () => {
      vi.mocked(isTauri).mockReturnValue(true)
      vi.mocked(getCachedMessages).mockResolvedValueOnce([
        {
          message_id: 'msg-1',
          channel_id: 'ch-1',
          plaintext: 'cached text',
          created_at: '2026-01-01',
        },
      ])

      const { result } = renderHook(() => useEncryptedMessages())

      await result.current.loadCachedDecryptions('ch-1')

      expect(result.current.getCachedPlaintext('msg-1')).toBe('cached text')
    })

    it('logs warning when cache load fails', async () => {
      vi.mocked(isTauri).mockReturnValue(true)
      vi.mocked(getCachedMessages).mockRejectedValueOnce(new Error('SQLCipher error'))

      const { result } = renderHook(() => useEncryptedMessages())

      await result.current.loadCachedDecryptions('ch-1')

      expect(logger.warn).toHaveBeenCalledWith(
        'Failed to load cached decryptions',
        expect.objectContaining({
          channelId: 'ch-1',
        }),
      )
    })
  })

  describe('getCachedPlaintext', () => {
    it('returns undefined for unknown message ID', () => {
      vi.mocked(isTauri).mockReturnValue(true)

      const { result } = renderHook(() => useEncryptedMessages())

      expect(result.current.getCachedPlaintext('unknown')).toBeUndefined()
    })
  })
})
