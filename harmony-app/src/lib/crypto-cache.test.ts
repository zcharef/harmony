import { vi } from 'vitest'

vi.mock('@/lib/platform', () => ({
  isTauri: vi.fn(),
}))

// WHY: Mock @tauri-apps/api/core to avoid crash in jsdom environment.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

const { isTauri } = await import('@/lib/platform')
const { invoke } = await import('@tauri-apps/api/core')

// Import after mocks are set up
const {
  initCache,
  cacheMessage,
  getCachedMessages,
  updateCachedMessage,
  deleteCachedMessage,
  setTrustLevel,
  getTrustLevel,
} = await import('@/lib/crypto-cache')

describe('crypto-cache', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('when not in Tauri (web)', () => {
    beforeEach(() => {
      vi.mocked(isTauri).mockReturnValue(false)
    })

    it('initCache throws on web', async () => {
      await expect(initCache('user-1')).rejects.toThrow('Message cache requires desktop app')
    })

    it('cacheMessage throws on web', async () => {
      await expect(cacheMessage('msg-1', 'ch-1', 'hello', '2026-01-01')).rejects.toThrow(
        'Message cache requires desktop app',
      )
    })

    it('getCachedMessages throws on web', async () => {
      await expect(getCachedMessages('ch-1')).rejects.toThrow('Message cache requires desktop app')
    })

    it('setTrustLevel throws on web', async () => {
      await expect(setTrustLevel('user-1', 'verified')).rejects.toThrow(
        'Message cache requires desktop app',
      )
    })

    it('getTrustLevel throws on web', async () => {
      await expect(getTrustLevel('user-1')).rejects.toThrow('Message cache requires desktop app')
    })
  })

  describe('when in Tauri (desktop)', () => {
    beforeEach(() => {
      vi.mocked(isTauri).mockReturnValue(true)
    })

    it('initCache invokes the correct Tauri command', async () => {
      vi.mocked(invoke).mockResolvedValueOnce(undefined)

      await initCache('user-1')

      expect(invoke).toHaveBeenCalledWith('cache_init', { userId: 'user-1' })
    })

    it('cacheMessage invokes with all parameters', async () => {
      vi.mocked(invoke).mockResolvedValueOnce(undefined)

      await cacheMessage('msg-1', 'ch-1', 'hello world', '2026-01-01T00:00:00Z')

      expect(invoke).toHaveBeenCalledWith('cache_message', {
        messageId: 'msg-1',
        channelId: 'ch-1',
        plaintext: 'hello world',
        createdAt: '2026-01-01T00:00:00Z',
      })
    })

    it('getCachedMessages returns cached messages', async () => {
      const mockMessages = [
        {
          message_id: 'msg-1',
          channel_id: 'ch-1',
          plaintext: 'hello',
          created_at: '2026-01-01T00:00:00Z',
        },
      ]
      vi.mocked(invoke).mockResolvedValueOnce(mockMessages)

      const result = await getCachedMessages('ch-1')

      expect(result).toEqual(mockMessages)
      expect(invoke).toHaveBeenCalledWith('get_cached_messages', {
        channelId: 'ch-1',
        beforeCursor: undefined,
        limit: undefined,
      })
    })

    it('getCachedMessages passes optional pagination params', async () => {
      vi.mocked(invoke).mockResolvedValueOnce([])

      await getCachedMessages('ch-1', '2026-01-01', 25)

      expect(invoke).toHaveBeenCalledWith('get_cached_messages', {
        channelId: 'ch-1',
        beforeCursor: '2026-01-01',
        limit: 25,
      })
    })

    it('updateCachedMessage invokes correctly', async () => {
      vi.mocked(invoke).mockResolvedValueOnce(undefined)

      await updateCachedMessage('msg-1', 'updated text')

      expect(invoke).toHaveBeenCalledWith('update_cached_message', {
        messageId: 'msg-1',
        newPlaintext: 'updated text',
      })
    })

    it('deleteCachedMessage invokes correctly', async () => {
      vi.mocked(invoke).mockResolvedValueOnce(undefined)

      await deleteCachedMessage('msg-1')

      expect(invoke).toHaveBeenCalledWith('delete_cached_message', { messageId: 'msg-1' })
    })

    it('setTrustLevel invokes correctly', async () => {
      vi.mocked(invoke).mockResolvedValueOnce(undefined)

      await setTrustLevel('user-1', 'verified')

      expect(invoke).toHaveBeenCalledWith('crypto_set_trust_level', {
        userId: 'user-1',
        level: 'verified',
      })
    })

    it('getTrustLevel returns the trust level', async () => {
      vi.mocked(invoke).mockResolvedValueOnce('blocked')

      const result = await getTrustLevel('user-1')

      expect(result).toBe('blocked')
      expect(invoke).toHaveBeenCalledWith('crypto_get_trust_level', { userId: 'user-1' })
    })
  })
})
