import { renderHook, waitFor } from '@testing-library/react'
import { vi } from 'vitest'
import type { MessageListResponse } from '@/lib/api'
import { createQueryWrapper, createTestQueryClient } from '@/tests/test-utils'
import { useMessages } from './use-messages'

vi.mock('@/lib/api', () => ({
  listMessages: vi.fn(),
}))

const { listMessages } = await import('@/lib/api')

const CHANNEL_ID = 'channel-42'

function buildPageResponse(
  items: MessageListResponse['items'] = [],
  nextCursor: string | null = null,
): MessageListResponse {
  return { items, nextCursor }
}

describe('useMessages', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('is disabled when channelId is null', () => {
    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)

    const { result } = renderHook(() => useMessages(null), { wrapper })

    // When enabled=false, the query should never enter loading/fetching state
    expect(result.current.isFetching).toBe(false)
    expect(result.current.data).toBeUndefined()
    expect(listMessages).not.toHaveBeenCalled()
  })

  it('fetches messages with correct path and query params', async () => {
    const page = buildPageResponse(
      [
        {
          id: 'msg-1',
          channelId: CHANNEL_ID,
          authorId: 'user-1',
          content: 'hello',
          createdAt: '2026-03-16T00:00:00.000Z',
        },
      ],
      null,
    )
    vi.mocked(listMessages).mockResolvedValueOnce({ data: page } as never)

    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)

    const { result } = renderHook(() => useMessages(CHANNEL_ID), { wrapper })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(listMessages).toHaveBeenCalledOnce()
    expect(listMessages).toHaveBeenCalledWith({
      path: { id: CHANNEL_ID },
      query: { before: undefined, limit: 50 },
      throwOnError: true,
    })

    expect(result.current.data?.pages).toHaveLength(1)
    expect(result.current.data?.pages[0]?.items[0]?.id).toBe('msg-1')
  })

  it('returns nextCursor as the next page param when present', async () => {
    const page = buildPageResponse(
      [
        {
          id: 'msg-1',
          channelId: CHANNEL_ID,
          authorId: 'user-1',
          content: 'hello',
          createdAt: '2026-03-16T00:00:00.000Z',
        },
      ],
      '2026-03-15T23:59:00.000Z',
    )
    vi.mocked(listMessages).mockResolvedValueOnce({ data: page } as never)

    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)

    const { result } = renderHook(() => useMessages(CHANNEL_ID), { wrapper })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(result.current.hasNextPage).toBe(true)
  })

  it('returns undefined as the next page param when nextCursor is null', async () => {
    const page = buildPageResponse([], null)
    vi.mocked(listMessages).mockResolvedValueOnce({ data: page } as never)

    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)

    const { result } = renderHook(() => useMessages(CHANNEL_ID), { wrapper })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(result.current.hasNextPage).toBe(false)
  })
})
