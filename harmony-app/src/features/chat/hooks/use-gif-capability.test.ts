import { renderHook, waitFor } from '@testing-library/react'
import { vi } from 'vitest'
import { createQueryWrapper, createTestQueryClient } from '@/tests/test-utils'
import { useGifCapability } from './use-gif-capability'

vi.mock('@/lib/api', () => ({
  trendingGifs: vi.fn(),
}))

const { trendingGifs } = await import('@/lib/api')

describe('useGifCapability', () => {
  beforeEach(() => vi.clearAllMocks())

  it('is enabled while the probe is in flight (optimistic default)', () => {
    vi.mocked(trendingGifs).mockReturnValue(new Promise(() => {}) as never)
    const wrapper = createQueryWrapper(createTestQueryClient())
    const { result } = renderHook(() => useGifCapability(), { wrapper })
    expect(result.current).toBe(true)
  })

  it('stays enabled when the probe succeeds', async () => {
    vi.mocked(trendingGifs).mockResolvedValueOnce({
      data: { items: [], hasNext: false, page: 1 },
    } as never)
    const wrapper = createQueryWrapper(createTestQueryClient())
    const { result } = renderHook(() => useGifCapability(), { wrapper })
    await waitFor(() => expect(trendingGifs).toHaveBeenCalled())
    expect(result.current).toBe(true)
  })

  it('flips to disabled on a 503 (feature off)', async () => {
    vi.mocked(trendingGifs).mockRejectedValueOnce({ status: 503, detail: 'not configured' })
    const wrapper = createQueryWrapper(createTestQueryClient())
    const { result } = renderHook(() => useGifCapability(), { wrapper })
    await waitFor(() => expect(result.current).toBe(false))
  })

  it('stays enabled on a transient upstream error (fail-open)', async () => {
    vi.mocked(trendingGifs).mockRejectedValueOnce({ status: 502, detail: 'provider down' })
    const wrapper = createQueryWrapper(createTestQueryClient())
    const { result } = renderHook(() => useGifCapability(), { wrapper })
    await waitFor(() => expect(trendingGifs).toHaveBeenCalled())
    expect(result.current).toBe(true)
  })
})
