import { vi } from 'vitest'
import { renderHook } from '@testing-library/react'

vi.mock('@/lib/crypto-megolm', () => ({
  megolmEncrypt: vi.fn(),
  megolmDecrypt: vi.fn(),
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

const { megolmEncrypt, megolmDecrypt } = await import('@/lib/crypto-megolm')
const { cacheMessage, getCachedMessages } = await import('@/lib/crypto-cache')
const { isTauri } = await import('@/lib/platform')
const { logger } = await import('@/lib/logger')
const { useChannelEncryption } = await import('./use-channel-encryption')

beforeEach(() => {
  vi.clearAllMocks()
})

function buildMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-1',
    channelId: 'ch-1',
    authorId: 'user-1',
    authorUsername: 'alice',
    content: 'some content',
    createdAt: '2026-03-16T00:00:00.000Z',
    encrypted: false,
    ...overrides,
  }
}

describe('useChannelEncryption', () => {
  describe('encryptChannelMessage', () => {
    it('throws when not running in Tauri', async () => {
      vi.mocked(isTauri).mockReturnValue(false)

      const { result } = renderHook(() => useChannelEncryption())

      await expect(
        result.current.encryptChannelMessage('ch-1', 'hello', 'device-1'),
      ).rejects.toThrow('Channel encryption requires desktop app')
    })

    it('encrypts plaintext and returns content envelope with device ID', async () => {
      vi.mocked(isTauri).mockReturnValue(true)
      vi.mocked(megolmEncrypt).mockResolvedValueOnce({
        session_id: 'megolm-session-1',
        ciphertext: 'encrypted-data',
      })

      const { result } = renderHook(() => useChannelEncryption())

      const encrypted = await result.current.encryptChannelMessage('ch-1', 'hello', 'device-1')

      expect(encrypted.senderDeviceId).toBe('device-1')
      const parsed = JSON.parse(encrypted.content)
      expect(parsed).toEqual({
        session_id: 'megolm-session-1',
        ciphertext: 'encrypted-data',
      })
      expect(megolmEncrypt).toHaveBeenCalledWith('ch-1', 'hello')
    })
  })

  describe('decryptChannelMessage', () => {
    it('returns desktop_required error on web', async () => {
      vi.mocked(isTauri).mockReturnValue(false)

      const { result } = renderHook(() => useChannelEncryption())
      const msg = buildMessage({ encrypted: true })

      const decrypted = await result.current.decryptChannelMessage(msg as never)

      expect(decrypted).toEqual({
        plaintext: null,
        error: 'desktop_required',
        identityKeyChanged: false,
      })
    })

    it('returns plaintext content directly for non-encrypted messages', async () => {
      vi.mocked(isTauri).mockReturnValue(true)

      const { result } = renderHook(() => useChannelEncryption())
      const msg = buildMessage({ encrypted: false, content: 'plain hello' })

      const decrypted = await result.current.decryptChannelMessage(msg as never)

      expect(decrypted).toEqual({
        plaintext: 'plain hello',
        error: null,
        identityKeyChanged: false,
      })
    })

    it('decrypts an encrypted message and caches the result', async () => {
      vi.mocked(isTauri).mockReturnValue(true)
      vi.mocked(megolmDecrypt).mockResolvedValueOnce('decrypted hello')
      vi.mocked(cacheMessage).mockResolvedValueOnce(undefined)

      const envelope = JSON.stringify({
        session_id: 'megolm-session-1',
        ciphertext: 'encrypted-data',
      })
      const msg = buildMessage({ encrypted: true, content: envelope })

      const { result } = renderHook(() => useChannelEncryption())

      const decrypted = await result.current.decryptChannelMessage(msg as never)

      expect(decrypted).toEqual({
        plaintext: 'decrypted hello',
        error: null,
        identityKeyChanged: false,
      })
      expect(megolmDecrypt).toHaveBeenCalledWith('ch-1', 'megolm-session-1', 'encrypted-data')
    })

    it('returns cached plaintext on second call without re-decrypting', async () => {
      vi.mocked(isTauri).mockReturnValue(true)
      vi.mocked(megolmDecrypt).mockResolvedValueOnce('decrypted hello')
      vi.mocked(cacheMessage).mockResolvedValueOnce(undefined)

      const envelope = JSON.stringify({
        session_id: 'megolm-session-1',
        ciphertext: 'encrypted-data',
      })
      const msg = buildMessage({ encrypted: true, content: envelope })

      const { result } = renderHook(() => useChannelEncryption())

      // First call — decrypts
      await result.current.decryptChannelMessage(msg as never)
      // Second call — should use cache
      const decrypted = await result.current.decryptChannelMessage(msg as never)

      expect(decrypted.plaintext).toBe('decrypted hello')
      expect(megolmDecrypt).toHaveBeenCalledOnce()
    })

    it('returns error result when decryption fails', async () => {
      vi.mocked(isTauri).mockReturnValue(true)
      vi.mocked(megolmDecrypt).mockRejectedValueOnce(new Error('bad ciphertext'))

      const envelope = JSON.stringify({
        session_id: 's1',
        ciphertext: 'bad-data',
      })
      const msg = buildMessage({ encrypted: true, content: envelope })

      const { result } = renderHook(() => useChannelEncryption())

      const decrypted = await result.current.decryptChannelMessage(msg as never)

      expect(decrypted).toEqual({
        plaintext: null,
        error: 'bad ciphertext',
        identityKeyChanged: false,
      })
      expect(logger.error).toHaveBeenCalledWith('Channel message decryption failed', expect.any(Object))
    })

    it('returns error for invalid envelope JSON', async () => {
      vi.mocked(isTauri).mockReturnValue(true)

      const msg = buildMessage({ encrypted: true, content: '{ invalid json' })

      const { result } = renderHook(() => useChannelEncryption())

      const decrypted = await result.current.decryptChannelMessage(msg as never)

      expect(decrypted.plaintext).toBeNull()
      expect(decrypted.error).toBeTruthy()
    })
  })

  describe('loadCachedChannelDecryptions', () => {
    it('does nothing on web', async () => {
      vi.mocked(isTauri).mockReturnValue(false)

      const { result } = renderHook(() => useChannelEncryption())

      await result.current.loadCachedChannelDecryptions('ch-1')

      expect(getCachedMessages).not.toHaveBeenCalled()
    })

    it('pre-warms the in-memory cache from SQLCipher', async () => {
      vi.mocked(isTauri).mockReturnValue(true)
      vi.mocked(getCachedMessages).mockResolvedValueOnce([
        { message_id: 'msg-1', channel_id: 'ch-1', plaintext: 'cached hello', created_at: '2026-01-01' },
      ])

      const { result } = renderHook(() => useChannelEncryption())

      await result.current.loadCachedChannelDecryptions('ch-1')

      const cached = result.current.getCachedPlaintext('msg-1')
      expect(cached).toBe('cached hello')
    })

    it('logs warning when cache load fails', async () => {
      vi.mocked(isTauri).mockReturnValue(true)
      vi.mocked(getCachedMessages).mockRejectedValueOnce(new Error('db error'))

      const { result } = renderHook(() => useChannelEncryption())

      await result.current.loadCachedChannelDecryptions('ch-1')

      expect(logger.warn).toHaveBeenCalledWith('Failed to load cached channel decryptions', expect.objectContaining({
        channelId: 'ch-1',
      }))
    })
  })

  describe('getCachedPlaintext', () => {
    it('returns undefined for unknown message ID', () => {
      vi.mocked(isTauri).mockReturnValue(true)

      const { result } = renderHook(() => useChannelEncryption())

      expect(result.current.getCachedPlaintext('unknown')).toBeUndefined()
    })
  })
})
