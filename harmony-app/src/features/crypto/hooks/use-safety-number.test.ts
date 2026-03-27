import { vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

vi.mock('@/lib/crypto', () => ({
  generateSafetyNumber: vi.fn(),
  getIdentityKeys: vi.fn(),
}))

vi.mock('@/lib/platform', () => ({
  isTauri: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

const { generateSafetyNumber, getIdentityKeys } = await import('@/lib/crypto')
const { isTauri } = await import('@/lib/platform')
const { logger } = await import('@/lib/logger')

const { useCryptoStore } = await import('@/features/crypto/stores/crypto-store')
const { useSafetyNumber } = await import('./use-safety-number')

const cryptoInitialState = useCryptoStore.getState()

beforeEach(() => {
  vi.clearAllMocks()
  useCryptoStore.setState(cryptoInitialState, true)
})

describe('useSafetyNumber', () => {
  it('returns null safety number and stops loading on web', async () => {
    vi.mocked(isTauri).mockReturnValue(false)

    const { result } = renderHook(() => useSafetyNumber('user-1'))

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.safetyNumber).toBeNull()
    expect(generateSafetyNumber).not.toHaveBeenCalled()
  })

  it('returns null and stops loading when recipientUserId is null', async () => {
    vi.mocked(isTauri).mockReturnValue(true)

    const { result } = renderHook(() => useSafetyNumber(null))

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.safetyNumber).toBeNull()
  })

  it('returns null and stops loading when recipient identity key is unknown', async () => {
    vi.mocked(isTauri).mockReturnValue(true)
    // No known identity key stored for user-1

    const { result } = renderHook(() => useSafetyNumber('user-1'))

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.safetyNumber).toBeNull()
  })

  it('generates safety number when all conditions are met', async () => {
    vi.mocked(isTauri).mockReturnValue(true)
    useCryptoStore.getState().setKnownIdentityKey('user-1', 'their-id-key')

    vi.mocked(getIdentityKeys).mockResolvedValueOnce({
      identity_key: 'our-id-key',
      signing_key: 'our-sign-key',
    })
    vi.mocked(generateSafetyNumber).mockResolvedValueOnce('12345 67890 12345')

    const { result } = renderHook(() => useSafetyNumber('user-1'))

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.safetyNumber).toBe('12345 67890 12345')
    expect(generateSafetyNumber).toHaveBeenCalledWith('our-id-key', 'their-id-key')
  })

  it('logs warning and returns null when generation fails', async () => {
    vi.mocked(isTauri).mockReturnValue(true)
    useCryptoStore.getState().setKnownIdentityKey('user-1', 'their-id-key')

    vi.mocked(getIdentityKeys).mockRejectedValueOnce(new Error('key store locked'))

    const { result } = renderHook(() => useSafetyNumber('user-1'))

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.safetyNumber).toBeNull()
    expect(logger.warn).toHaveBeenCalledWith(
      'Failed to generate safety number',
      expect.objectContaining({ recipientUserId: 'user-1' }),
    )
  })
})
