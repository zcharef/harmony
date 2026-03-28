import { act, renderHook, waitFor } from '@testing-library/react'
import { vi } from 'vitest'

vi.mock('@/lib/crypto-cache', () => ({
  getTrustLevel: vi.fn(),
  setTrustLevel: vi.fn(),
}))

vi.mock('@/lib/platform', () => ({
  isTauri: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

const { getTrustLevel, setTrustLevel } = await import('@/lib/crypto-cache')
const { isTauri } = await import('@/lib/platform')
const { logger } = await import('@/lib/logger')
const { useTrustLevel } = await import('./use-trust-level')

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useTrustLevel', () => {
  describe('loading trust level', () => {
    it('returns unverified and stops loading on web', async () => {
      vi.mocked(isTauri).mockReturnValue(false)

      const { result } = renderHook(() => useTrustLevel('user-1'))

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      expect(result.current.trustLevel).toBe('unverified')
      expect(getTrustLevel).not.toHaveBeenCalled()
    })

    it('returns unverified and stops loading when userId is null', async () => {
      vi.mocked(isTauri).mockReturnValue(true)

      const { result } = renderHook(() => useTrustLevel(null))

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      expect(result.current.trustLevel).toBe('unverified')
    })

    it('loads trust level from SQLCipher on desktop', async () => {
      vi.mocked(isTauri).mockReturnValue(true)
      vi.mocked(getTrustLevel).mockResolvedValueOnce('verified')

      const { result } = renderHook(() => useTrustLevel('user-1'))

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      expect(result.current.trustLevel).toBe('verified')
      expect(getTrustLevel).toHaveBeenCalledWith('user-1')
    })

    it('logs warning and defaults to unverified when load fails', async () => {
      vi.mocked(isTauri).mockReturnValue(true)
      vi.mocked(getTrustLevel).mockRejectedValueOnce(new Error('db locked'))

      const { result } = renderHook(() => useTrustLevel('user-1'))

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      expect(result.current.trustLevel).toBe('unverified')
      expect(logger.warn).toHaveBeenCalledWith(
        'Failed to load trust level',
        expect.objectContaining({ userId: 'user-1' }),
      )
    })
  })

  describe('setLevel', () => {
    it('does nothing on web', async () => {
      vi.mocked(isTauri).mockReturnValue(false)

      const { result } = renderHook(() => useTrustLevel('user-1'))

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      await act(async () => {
        await result.current.setLevel('verified')
      })

      expect(setTrustLevel).not.toHaveBeenCalled()
    })

    it('does nothing when userId is null', async () => {
      vi.mocked(isTauri).mockReturnValue(true)

      const { result } = renderHook(() => useTrustLevel(null))

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      await act(async () => {
        await result.current.setLevel('verified')
      })

      expect(setTrustLevel).not.toHaveBeenCalled()
    })

    it('updates trust level in SQLCipher and local state', async () => {
      vi.mocked(isTauri).mockReturnValue(true)
      vi.mocked(getTrustLevel).mockResolvedValueOnce('unverified')
      vi.mocked(setTrustLevel).mockResolvedValueOnce(undefined)

      const { result } = renderHook(() => useTrustLevel('user-1'))

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      await act(async () => {
        await result.current.setLevel('verified')
      })

      expect(result.current.trustLevel).toBe('verified')
      expect(setTrustLevel).toHaveBeenCalledWith('user-1', 'verified')
      expect(logger.info).toHaveBeenCalledWith('trust_level_updated', {
        userId: 'user-1',
        level: 'verified',
      })
    })

    it('logs error and keeps old state when setTrustLevel fails', async () => {
      vi.mocked(isTauri).mockReturnValue(true)
      vi.mocked(getTrustLevel).mockResolvedValueOnce('unverified')
      vi.mocked(setTrustLevel).mockRejectedValueOnce(new Error('write failed'))

      const { result } = renderHook(() => useTrustLevel('user-1'))

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      await act(async () => {
        await result.current.setLevel('blocked')
      })

      // State should remain unchanged since the write failed
      expect(result.current.trustLevel).toBe('unverified')
      expect(logger.error).toHaveBeenCalledWith(
        'set_trust_level_failed',
        expect.objectContaining({
          userId: 'user-1',
          level: 'blocked',
        }),
      )
    })
  })
})
