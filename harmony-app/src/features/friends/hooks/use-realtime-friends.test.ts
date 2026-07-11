import { waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePresenceStore } from '@/features/presence'
import type { BlockedUserResponse, FriendRequestResponse, FriendResponse } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { renderHookWithQueryClient } from '@/tests/test-utils'
import { useRealtimeFriends } from './use-realtime-friends'

vi.mock('@/lib/api', () => ({
  listFriends: vi.fn(async () => ({ data: { items: [] } })),
  listRequests: vi.fn(async () => ({ data: { items: [] } })),
  listBlocks: vi.fn(async () => ({ data: { items: [] } })),
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

const { listFriends, listRequests, listBlocks } = await import('@/lib/api')
const { logger } = await import('@/lib/logger')

function dispatch(name: string, detail: unknown) {
  window.dispatchEvent(new CustomEvent(`sse:${name}`, { detail }))
}

function friendPayload(overrides: Record<string, unknown> = {}) {
  return {
    type: 'friendAdded',
    senderId: 's',
    targetUserId: 'me',
    friend: {
      userId: 'u-bob',
      username: 'bob',
      displayName: null,
      avatarUrl: null,
      status: 'online',
      friendsSince: '2026-01-01T00:00:00Z',
      ...overrides,
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  usePresenceStore.getState().clearAll()
})

describe('useRealtimeFriends', () => {
  it('eagerly mounts the three list queries (§5.2 warm-cache contract)', async () => {
    renderHookWithQueryClient(() => useRealtimeFriends())
    await waitFor(() => {
      expect(listFriends).toHaveBeenCalled()
      expect(listBlocks).toHaveBeenCalled()
      // once for incoming, once for outgoing
      expect(vi.mocked(listRequests).mock.calls.length).toBeGreaterThanOrEqual(2)
    })
  })

  it('friend.added inserts sorted, drops matching pending, and seeds presence', async () => {
    const { queryClient } = renderHookWithQueryClient(() => useRealtimeFriends())
    await waitFor(() => expect(queryClient.getQueryData(queryKeys.friends.list())).toBeDefined())

    const zed: FriendResponse = {
      user: { id: 'u-zed', username: 'zed' },
      friendsSince: '2026-01-01T00:00:00Z',
    }
    queryClient.setQueryData<FriendResponse[]>(queryKeys.friends.list(), [zed])
    const pending: FriendRequestResponse = {
      user: { id: 'u-bob', username: 'bob' },
      direction: 'incoming',
      createdAt: 'now',
    }
    queryClient.setQueryData<FriendRequestResponse[]>(queryKeys.friends.requests('incoming'), [
      pending,
    ])

    dispatch('friend.added', friendPayload())

    const friends = queryClient.getQueryData<FriendResponse[]>(queryKeys.friends.list())
    expect(friends?.map((f) => f.user.username)).toEqual(['bob', 'zed']) // username sort
    expect(
      queryClient.getQueryData<FriendRequestResponse[]>(queryKeys.friends.requests('incoming')),
    ).toEqual([])
    expect(usePresenceStore.getState().presenceMap.get('u-bob')).toBe('online')
  })

  it('friend.added does NOT write an offline presence entry (absence = offline)', async () => {
    const { queryClient } = renderHookWithQueryClient(() => useRealtimeFriends())
    await waitFor(() => expect(queryClient.getQueryData(queryKeys.friends.list())).toBeDefined())
    queryClient.setQueryData<FriendResponse[]>(queryKeys.friends.list(), [])

    dispatch('friend.added', friendPayload({ status: 'offline' }))

    expect(usePresenceStore.getState().presenceMap.has('u-bob')).toBe(false)
  })

  it('friend.request_created prepends to the matching direction cache', async () => {
    const { queryClient } = renderHookWithQueryClient(() => useRealtimeFriends())
    await waitFor(() =>
      expect(queryClient.getQueryData(queryKeys.friends.requests('incoming'))).toBeDefined(),
    )
    queryClient.setQueryData<FriendRequestResponse[]>(queryKeys.friends.requests('incoming'), [])

    dispatch('friend.request_created', {
      type: 'friendRequestCreated',
      senderId: 's',
      targetUserId: 'me',
      request: {
        userId: 'u-ann',
        username: 'ann',
        displayName: null,
        avatarUrl: null,
        direction: 'incoming',
        createdAt: 'now',
      },
    })

    expect(
      queryClient.getQueryData<FriendRequestResponse[]>(queryKeys.friends.requests('incoming')),
    ).toHaveLength(1)
  })

  it('friend.removed drops the friend from the list', async () => {
    const { queryClient } = renderHookWithQueryClient(() => useRealtimeFriends())
    await waitFor(() => expect(queryClient.getQueryData(queryKeys.friends.list())).toBeDefined())
    queryClient.setQueryData<FriendResponse[]>(queryKeys.friends.list(), [
      { user: { id: 'u-bob', username: 'bob' }, friendsSince: 'x' },
    ])

    dispatch('friend.removed', {
      type: 'friendRemoved',
      senderId: 's',
      targetUserId: 'me',
      userId: 'u-bob',
    })

    expect(queryClient.getQueryData<FriendResponse[]>(queryKeys.friends.list())).toEqual([])
  })

  it('block.removed drops the entry from the blocks cache', async () => {
    const { queryClient } = renderHookWithQueryClient(() => useRealtimeFriends())
    await waitFor(() => expect(queryClient.getQueryData(queryKeys.friends.blocks())).toBeDefined())
    queryClient.setQueryData<BlockedUserResponse[]>(queryKeys.friends.blocks(), [
      { user: { id: 'u-x', username: 'x' }, blockedAt: 'x' },
    ])

    dispatch('block.removed', {
      type: 'blockRemoved',
      senderId: 's',
      targetUserId: 'me',
      userId: 'u-x',
    })

    expect(queryClient.getQueryData<BlockedUserResponse[]>(queryKeys.friends.blocks())).toEqual([])
  })

  it('logs a warning and does not crash on a malformed payload', async () => {
    const { queryClient } = renderHookWithQueryClient(() => useRealtimeFriends())
    await waitFor(() => expect(queryClient.getQueryData(queryKeys.friends.list())).toBeDefined())

    dispatch('friend.added', { nope: true })

    expect(logger.warn).toHaveBeenCalled()
  })
})
