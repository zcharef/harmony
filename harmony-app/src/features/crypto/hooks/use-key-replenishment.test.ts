import { renderHook } from '@testing-library/react'
import { vi } from 'vitest'

vi.mock('@/lib/api', () => ({
  getKeyCount: vi.fn(),
  uploadOneTimeKeys: vi.fn(),
}))

vi.mock('@/lib/crypto', () => ({
  generateOneTimeKeys: vi.fn(),
}))

vi.mock('@/lib/platform', () => ({
  isTauri: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

const { getKeyCount, uploadOneTimeKeys } = await import('@/lib/api')
const { generateOneTimeKeys } = await import('@/lib/crypto')
const { isTauri } = await import('@/lib/platform')
const { logger } = await import('@/lib/logger')

const { useCryptoStore } = await import('@/features/crypto/stores/crypto-store')
const { useKeyReplenishment } = await import('./use-key-replenishment')

const cryptoInitialState = useCryptoStore.getState()

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  useCryptoStore.setState(cryptoInitialState, true)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useKeyReplenishment', () => {
  it('does nothing on web', () => {
    vi.mocked(isTauri).mockReturnValue(false)
    useCryptoStore.getState().setInitialized(true)
    useCryptoStore.getState().setDeviceId('device-1')

    renderHook(() => useKeyReplenishment())

    expect(getKeyCount).not.toHaveBeenCalled()
  })

  it('does nothing when crypto is not initialized', () => {
    vi.mocked(isTauri).mockReturnValue(true)
    useCryptoStore.getState().setDeviceId('device-1')
    // isInitialized defaults to false

    renderHook(() => useKeyReplenishment())

    expect(getKeyCount).not.toHaveBeenCalled()
  })

  it('does nothing when deviceId is null', () => {
    vi.mocked(isTauri).mockReturnValue(true)
    useCryptoStore.getState().setInitialized(true)
    // deviceId defaults to null

    renderHook(() => useKeyReplenishment())

    expect(getKeyCount).not.toHaveBeenCalled()
  })

  it('skips replenishment when key count is above threshold', async () => {
    vi.mocked(isTauri).mockReturnValue(true)
    vi.mocked(getKeyCount).mockResolvedValueOnce({ data: { count: 30 } } as never)

    useCryptoStore.getState().setInitialized(true)
    useCryptoStore.getState().setDeviceId('device-1')

    renderHook(() => useKeyReplenishment())

    // Flush the microtask queue for the immediate check
    await vi.advanceTimersByTimeAsync(0)

    expect(getKeyCount).toHaveBeenCalledWith({
      query: { device_id: 'device-1' },
      throwOnError: true,
    })
    expect(generateOneTimeKeys).not.toHaveBeenCalled()
  })

  it('generates and uploads keys when count is below threshold', async () => {
    vi.mocked(isTauri).mockReturnValue(true)
    vi.mocked(getKeyCount).mockResolvedValueOnce({ data: { count: 10 } } as never)
    vi.mocked(generateOneTimeKeys).mockResolvedValueOnce([
      { key_id: 'new-1', public_key: 'pub-1' },
      { key_id: 'new-2', public_key: 'pub-2' },
    ])
    vi.mocked(uploadOneTimeKeys).mockResolvedValueOnce({ data: undefined } as never)

    useCryptoStore.getState().setInitialized(true)
    useCryptoStore.getState().setDeviceId('device-1')

    renderHook(() => useKeyReplenishment())

    await vi.advanceTimersByTimeAsync(0)

    expect(generateOneTimeKeys).toHaveBeenCalledWith(50)
    expect(uploadOneTimeKeys).toHaveBeenCalledWith({
      body: {
        deviceId: 'device-1',
        keys: [
          { keyId: 'new-1', publicKey: 'pub-1', isFallback: false },
          { keyId: 'new-2', publicKey: 'pub-2', isFallback: false },
        ],
      },
      throwOnError: true,
    })
    expect(logger.info).toHaveBeenCalledWith(
      'One-time keys replenished',
      expect.objectContaining({ uploadedCount: 2, deviceId: 'device-1' }),
    )
  })

  it('logs error and continues when replenishment fails', async () => {
    vi.mocked(isTauri).mockReturnValue(true)
    vi.mocked(getKeyCount).mockRejectedValueOnce(new Error('network down'))

    useCryptoStore.getState().setInitialized(true)
    useCryptoStore.getState().setDeviceId('device-1')

    renderHook(() => useKeyReplenishment())

    await vi.advanceTimersByTimeAsync(0)

    expect(logger.error).toHaveBeenCalledWith(
      'Key replenishment failed',
      expect.objectContaining({ error: 'network down' }),
    )
  })

  it('sets up periodic check interval', async () => {
    vi.mocked(isTauri).mockReturnValue(true)
    vi.mocked(getKeyCount).mockResolvedValue({ data: { count: 50 } } as never)

    useCryptoStore.getState().setInitialized(true)
    useCryptoStore.getState().setDeviceId('device-1')

    renderHook(() => useKeyReplenishment())

    // Initial check
    await vi.advanceTimersByTimeAsync(0)
    expect(getKeyCount).toHaveBeenCalledOnce()

    // Advance to next interval (5 minutes)
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    expect(getKeyCount).toHaveBeenCalledTimes(2)
  })

  it('clears interval on unmount', async () => {
    vi.mocked(isTauri).mockReturnValue(true)
    vi.mocked(getKeyCount).mockResolvedValue({ data: { count: 50 } } as never)

    useCryptoStore.getState().setInitialized(true)
    useCryptoStore.getState().setDeviceId('device-1')

    const { unmount } = renderHook(() => useKeyReplenishment())

    await vi.advanceTimersByTimeAsync(0)
    expect(getKeyCount).toHaveBeenCalledOnce()

    unmount()

    // After unmount, advancing time should NOT trigger another check
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    expect(getKeyCount).toHaveBeenCalledOnce()
  })
})
