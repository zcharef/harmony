import { QueryClient } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FriendRequestResponse } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { createQueryWrapper } from '@/tests/test-utils'
import { useAcceptFriendRequest } from './use-accept-friend-request'

// WHY gcTime Infinity: onSettled invalidates the incoming query, which with the
// default gcTime:0 test client garbage-collects the (observer-less) cache entry
// to `undefined`. Persisting it lets us assert the optimistic/rollback state.
function renderAccept() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  })
  const wrapper = createQueryWrapper(queryClient)
  const { result } = renderHook(() => useAcceptFriendRequest(), { wrapper })
  return { result, queryClient }
}

vi.mock('@/lib/api', () => ({
  acceptRequest: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

const { acceptRequest } = await import('@/lib/api')

const incoming: FriendRequestResponse[] = [
  { user: { id: 'u-bob', username: 'bob' }, direction: 'incoming', createdAt: 'now' },
]

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useAcceptFriendRequest', () => {
  it('optimistically removes the incoming entry', async () => {
    vi.mocked(acceptRequest).mockResolvedValueOnce({
      data: { user: { id: 'u-bob', username: 'bob' }, friendsSince: 'now' },
    } as never)

    const { result, queryClient } = renderAccept()
    queryClient.setQueryData(queryKeys.friends.requests('incoming'), incoming)

    result.current.mutate('u-bob')

    await waitFor(() =>
      expect(
        queryClient.getQueryData<FriendRequestResponse[]>(queryKeys.friends.requests('incoming')),
      ).toEqual([]),
    )
  })

  it('rolls back on a non-404 error', async () => {
    vi.mocked(acceptRequest).mockRejectedValueOnce({ status: 500, detail: 'boom' })

    const { result, queryClient } = renderAccept()
    queryClient.setQueryData(queryKeys.friends.requests('incoming'), incoming)

    result.current.mutate('u-bob')

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(
      queryClient.getQueryData<FriendRequestResponse[]>(queryKeys.friends.requests('incoming')),
    ).toEqual(incoming)
  })

  it('keeps the stale entry removed on a 404 (already gone)', async () => {
    vi.mocked(acceptRequest).mockRejectedValueOnce({ status: 404, detail: 'gone' })

    const { result, queryClient } = renderAccept()
    queryClient.setQueryData(queryKeys.friends.requests('incoming'), incoming)

    result.current.mutate('u-bob')

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(
      queryClient.getQueryData<FriendRequestResponse[]>(queryKeys.friends.requests('incoming')),
    ).toEqual([])
  })
})
