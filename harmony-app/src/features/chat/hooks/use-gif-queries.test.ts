import { renderHook, waitFor } from '@testing-library/react'
import { vi } from 'vitest'
import type { GifItem, GifListResponse } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { createQueryWrapper, createTestQueryClient } from '@/tests/test-utils'
import { useSearchGifs } from './use-search-gifs'
import { useTrendingGifs } from './use-trending-gifs'

vi.mock('@/lib/api', () => ({
  trendingGifs: vi.fn(),
  searchGifs: vi.fn(),
}))

const { trendingGifs, searchGifs } = await import('@/lib/api')

function gif(id: string): GifItem {
  return {
    id,
    title: id,
    url: `https://static.klipy.com/${id}.gif`,
    previewUrl: `https://static.klipy.com/${id}.webp`,
    width: 100,
    height: 100,
  }
}

function page(items: GifItem[], hasNext: boolean, pageNum = 1): GifListResponse {
  return { items, hasNext, page: pageNum }
}

describe('useTrendingGifs', () => {
  beforeEach(() => vi.clearAllMocks())

  it('does not fetch when disabled', () => {
    const wrapper = createQueryWrapper(createTestQueryClient())
    const { result } = renderHook(() => useTrendingGifs(false), { wrapper })
    expect(result.current.isFetching).toBe(false)
    expect(trendingGifs).not.toHaveBeenCalled()
  })

  it('fetches page 1 and exposes hasNext as the next page param', async () => {
    vi.mocked(trendingGifs).mockResolvedValueOnce({ data: page([gif('a')], true) } as never)
    const wrapper = createQueryWrapper(createTestQueryClient())
    const { result } = renderHook(() => useTrendingGifs(true), { wrapper })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(trendingGifs).toHaveBeenCalledWith({ query: { page: 1 }, throwOnError: true })
    expect(result.current.hasNextPage).toBe(true)
    expect(result.current.data?.pages[0]?.items[0]?.id).toBe('a')
  })

  it('stops paginating when hasNext is false', async () => {
    vi.mocked(trendingGifs).mockResolvedValueOnce({ data: page([gif('a')], false) } as never)
    const wrapper = createQueryWrapper(createTestQueryClient())
    const { result } = renderHook(() => useTrendingGifs(true), { wrapper })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.hasNextPage).toBe(false)
  })
})

describe('useSearchGifs', () => {
  beforeEach(() => vi.clearAllMocks())

  it('does not fetch for an empty query even when enabled', () => {
    const wrapper = createQueryWrapper(createTestQueryClient())
    const { result } = renderHook(() => useSearchGifs('   ', true), { wrapper })
    expect(result.current.isFetching).toBe(false)
    expect(searchGifs).not.toHaveBeenCalled()
  })

  it('does not fetch when the capability flag is off', () => {
    const wrapper = createQueryWrapper(createTestQueryClient())
    const { result } = renderHook(() => useSearchGifs('cats', false), { wrapper })
    expect(result.current.isFetching).toBe(false)
    expect(searchGifs).not.toHaveBeenCalled()
  })

  it('forwards the trimmed query and keys the cache by it', async () => {
    vi.mocked(searchGifs).mockResolvedValueOnce({ data: page([gif('x')], false) } as never)
    const client = createTestQueryClient()
    const wrapper = createQueryWrapper(client)
    const { result } = renderHook(() => useSearchGifs('  cats  ', true), { wrapper })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(searchGifs).toHaveBeenCalledWith({
      query: { q: 'cats', page: 1 },
      throwOnError: true,
    })
    // Cached under the query-key factory keyed by the trimmed query.
    expect(client.getQueryData(queryKeys.gifs.search('cats'))).toBeDefined()
  })
})
