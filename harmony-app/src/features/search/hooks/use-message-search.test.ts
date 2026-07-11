import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueryWrapper } from '@/tests/test-utils'

vi.mock('@/lib/api', () => ({
  searchMessages: vi.fn(),
}))

const { searchMessages } = await import('@/lib/api')
const { useMessageSearch } = await import('./use-message-search')

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useMessageSearch', () => {
  it('is disabled (fires no request) when q is empty', () => {
    const wrapper = createQueryWrapper()
    const { result } = renderHook(() => useMessageSearch({ serverId: 's1', q: '', has: [] }), {
      wrapper,
    })
    expect(searchMessages).not.toHaveBeenCalled()
    expect(result.current.isFetching).toBe(false)
  })

  it('is disabled when params are null', () => {
    const wrapper = createQueryWrapper()
    renderHook(() => useMessageSearch(null), { wrapper })
    expect(searchMessages).not.toHaveBeenCalled()
  })

  it('calls searchMessages with mapped params + throwOnError', async () => {
    vi.mocked(searchMessages).mockResolvedValueOnce({
      data: { items: [], nextCursor: undefined },
    } as never)

    const wrapper = createQueryWrapper()
    const { result } = renderHook(
      () =>
        useMessageSearch({
          serverId: 's1',
          q: 'hello',
          channelId: 'c1',
          authorId: 'a1',
          has: ['link', 'image'],
        }),
      { wrapper },
    )

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(searchMessages).toHaveBeenCalledWith({
      path: { id: 's1' },
      query: { q: 'hello', channelId: 'c1', authorId: 'a1', has: 'link,image' },
      throwOnError: true,
    })
  })

  it('omits absent optional filters from the query', async () => {
    vi.mocked(searchMessages).mockResolvedValueOnce({
      data: { items: [], nextCursor: undefined },
    } as never)

    const wrapper = createQueryWrapper()
    const { result } = renderHook(() => useMessageSearch({ serverId: 's1', q: 'hi', has: [] }), {
      wrapper,
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(searchMessages).toHaveBeenCalledWith({
      path: { id: 's1' },
      query: { q: 'hi' },
      throwOnError: true,
    })
  })

  it('exposes hasNextPage from nextCursor (getNextPageParam)', async () => {
    vi.mocked(searchMessages).mockResolvedValueOnce({
      data: { items: [{ id: 'm1' }], nextCursor: 'cursor-1' },
    } as never)

    const wrapper = createQueryWrapper()
    const { result } = renderHook(() => useMessageSearch({ serverId: 's1', q: 'hi', has: [] }), {
      wrapper,
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.hasNextPage).toBe(true)
  })

  it('surfaces the error (no silent swallow)', async () => {
    vi.mocked(searchMessages).mockRejectedValueOnce({ status: 500, detail: 'boom' })

    const wrapper = createQueryWrapper()
    const { result } = renderHook(() => useMessageSearch({ serverId: 's1', q: 'hi', has: [] }), {
      wrapper,
    })

    await waitFor(() => expect(result.current.isError).toBe(true))
  })
})
