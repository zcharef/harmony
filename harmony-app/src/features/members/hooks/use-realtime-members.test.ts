import { renderHook } from '@testing-library/react'
import { act } from 'react'
import { vi } from 'vitest'
import { SSE_EVENT_PREFIX } from '@/hooks/use-server-event'
import type { MemberListResponse, MemberResponse } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { createQueryWrapper, createTestQueryClient } from '@/tests/test-utils'
import { useRealtimeMembers } from './use-realtime-members'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

const { logger } = await import('@/lib/logger')

const SERVER_A = 'server-a'
const SERVER_B = 'server-b'

// -- Helpers -------------------------------------------------------------------

function buildMember(overrides: Partial<MemberResponse> = {}): MemberResponse {
  return {
    userId: 'user-1',
    username: 'alice',
    avatarUrl: null,
    nickname: null,
    role: 'member',
    isFounding: false,
    joinedAt: '2026-04-05T00:00:00.000Z',
    ...overrides,
  }
}

function buildCacheData(members: MemberResponse[]): MemberListResponse {
  return { items: members, nextCursor: null }
}

function buildJoinedEvent(serverId: string, member: MemberResponse) {
  return {
    serverId,
    member: {
      userId: member.userId,
      username: member.username,
      avatarUrl: member.avatarUrl,
      nickname: member.nickname,
      role: member.role,
      joinedAt: member.joinedAt,
    },
  }
}

function fireSSEEvent(eventName: string, payload: unknown) {
  window.dispatchEvent(new CustomEvent(`${SSE_EVENT_PREFIX}${eventName}`, { detail: payload }))
}

function getMembers(queryClient: ReturnType<typeof createTestQueryClient>, serverId: string) {
  return queryClient.getQueryData<MemberListResponse>(queryKeys.servers.members(serverId))
}

// -- Tests ---------------------------------------------------------------------

describe('useRealtimeMembers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // -- Regression: auto-join member list update (reactivity-bug-triage bug 2) ---
  // A new user auto-joined to the official server must appear in connected
  // clients' member lists via the member.joined SSE event.

  it('appends a new member to the server cache on member.joined', () => {
    const queryClient = createTestQueryClient()
    const existing = buildMember({ userId: 'user-existing', username: 'bob' })
    queryClient.setQueryData(queryKeys.servers.members(SERVER_A), buildCacheData([existing]))

    renderHook(() => useRealtimeMembers(), {
      wrapper: createQueryWrapper(queryClient),
    })

    const newMember = buildMember({ userId: 'user-new', username: 'carol' })
    act(() => {
      fireSSEEvent('member.joined', buildJoinedEvent(SERVER_A, newMember))
    })

    const cache = getMembers(queryClient, SERVER_A)
    expect(cache?.items).toHaveLength(2)
    expect(cache?.items[1]).toMatchObject({ userId: 'user-new', username: 'carol' })
  })

  it('deduplicates a repeated member.joined event (concurrent sync_profile)', () => {
    const queryClient = createTestQueryClient()
    queryClient.setQueryData(queryKeys.servers.members(SERVER_A), buildCacheData([]))

    renderHook(() => useRealtimeMembers(), {
      wrapper: createQueryWrapper(queryClient),
    })

    const member = buildMember({ userId: 'user-new' })
    act(() => {
      fireSSEEvent('member.joined', buildJoinedEvent(SERVER_A, member))
      fireSSEEvent('member.joined', buildJoinedEvent(SERVER_A, member))
    })

    expect(getMembers(queryClient, SERVER_A)?.items).toHaveLength(1)
  })

  // -- Regression: events for non-selected servers (commit e20d8d7) -------------
  // Member events must update the cache of the server they belong to, even
  // when the user is currently viewing a different server.

  it('updates the cache of a non-viewed server (event serverId keys the cache)', () => {
    const queryClient = createTestQueryClient()
    queryClient.setQueryData(
      queryKeys.servers.members(SERVER_A),
      buildCacheData([buildMember({ userId: 'user-a1' })]),
    )
    queryClient.setQueryData(
      queryKeys.servers.members(SERVER_B),
      buildCacheData([buildMember({ userId: 'user-b1' })]),
    )

    renderHook(() => useRealtimeMembers(), {
      wrapper: createQueryWrapper(queryClient),
    })

    const newMember = buildMember({ userId: 'user-new' })
    act(() => {
      fireSSEEvent('member.joined', buildJoinedEvent(SERVER_B, newMember))
    })

    // Server B (not viewed) got the update; server A is untouched.
    expect(getMembers(queryClient, SERVER_B)?.items).toHaveLength(2)
    expect(getMembers(queryClient, SERVER_A)?.items).toHaveLength(1)
  })

  it('does not create a phantom cache entry for an un-fetched server', () => {
    const queryClient = createTestQueryClient()
    // No cache seeded for SERVER_A.

    renderHook(() => useRealtimeMembers(), {
      wrapper: createQueryWrapper(queryClient),
    })

    act(() => {
      fireSSEEvent('member.joined', buildJoinedEvent(SERVER_A, buildMember()))
    })

    expect(getMembers(queryClient, SERVER_A)).toBeUndefined()
  })

  // -- member.removed -------------------------------------------------------------

  it('removes a member from the server cache on member.removed', () => {
    const queryClient = createTestQueryClient()
    queryClient.setQueryData(
      queryKeys.servers.members(SERVER_A),
      buildCacheData([buildMember({ userId: 'user-1' }), buildMember({ userId: 'user-2' })]),
    )

    renderHook(() => useRealtimeMembers(), {
      wrapper: createQueryWrapper(queryClient),
    })

    act(() => {
      fireSSEEvent('member.removed', { serverId: SERVER_A, userId: 'user-1' })
    })

    const cache = getMembers(queryClient, SERVER_A)
    expect(cache?.items).toHaveLength(1)
    expect(cache?.items[0]?.userId).toBe('user-2')
  })

  // -- Malformed payloads ----------------------------------------------------------

  it('logs an error and leaves the cache untouched on a malformed member.joined', () => {
    const queryClient = createTestQueryClient()
    queryClient.setQueryData(queryKeys.servers.members(SERVER_A), buildCacheData([buildMember()]))

    renderHook(() => useRealtimeMembers(), {
      wrapper: createQueryWrapper(queryClient),
    })

    act(() => {
      fireSSEEvent('member.joined', { serverId: SERVER_A, member: { userId: 42 } })
    })

    expect(logger.error).toHaveBeenCalledWith(
      'Malformed member.joined SSE payload',
      expect.anything(),
    )
    expect(getMembers(queryClient, SERVER_A)?.items).toHaveLength(1)
  })
})
