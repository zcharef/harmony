import { renderHook } from '@testing-library/react'
import { act } from 'react'
import { vi } from 'vitest'
import { useAuthStore } from '@/features/auth'
import { SSE_EVENT_PREFIX } from '@/hooks/use-server-event'
import type { ChannelResponse, MemberListResponse } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { createQueryWrapper, createTestQueryClient } from '@/tests/test-utils'
import { useRealtimeChannels } from './use-realtime-channels'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const { logger } = await import('@/lib/logger')

const SERVER_ID = 'srv-1'
const CHANNEL_ID = 'ch-priv'
const ME = 'user-me'

function fireSse(eventName: string, payload: unknown) {
  act(() => {
    window.dispatchEvent(new CustomEvent(`${SSE_EVENT_PREFIX}${eventName}`, { detail: payload }))
  })
}

function privateChannel(): ChannelResponse {
  return {
    id: CHANNEL_ID,
    serverId: SERVER_ID,
    name: 'ops',
    topic: null,
    channelType: 'text',
    position: 0,
    categoryId: null,
    isPrivate: true,
    isReadOnly: false,
    encrypted: false,
    slowModeSeconds: 0,
    createdAt: '2026-03-16T00:00:00.000Z',
    updatedAt: '2026-03-16T00:00:00.000Z',
  }
}

function members(role: string): MemberListResponse {
  return {
    items: [
      {
        userId: ME,
        username: 'me',
        displayName: null,
        avatarUrl: null,
        role,
        joinedAt: '2026-03-16T00:00:00.000Z',
      } as never,
    ],
    nextCursor: null,
  }
}

function setup(role: string, channels: ChannelResponse[]) {
  const queryClient = createTestQueryClient()
  queryClient.setQueryData(queryKeys.servers.members(SERVER_ID), members(role))
  queryClient.setQueryData(queryKeys.channels.byServer(SERVER_ID), channels)
  renderHook(() => useRealtimeChannels(), { wrapper: createQueryWrapper(queryClient) })
  return queryClient
}

beforeEach(() => {
  vi.clearAllMocks()
  useAuthStore.setState({ user: { id: ME } as never })
})

describe('useRealtimeChannels — channel.access_updated', () => {
  it('invalidates the channel list when I newly qualify and the channel is absent', () => {
    const queryClient = setup('member', [])
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    fireSse('channel.access_updated', {
      serverId: SERVER_ID,
      channelId: CHANNEL_ID,
      authorizedRoles: ['member'],
    })

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.channels.byServer(SERVER_ID),
    })
  })

  it('evicts the channel when I no longer qualify', () => {
    const queryClient = setup('member', [privateChannel()])

    fireSse('channel.access_updated', {
      serverId: SERVER_ID,
      channelId: CHANNEL_ID,
      authorizedRoles: ['moderator'],
    })

    const list = queryClient.getQueryData<ChannelResponse[]>(queryKeys.channels.byServer(SERVER_ID))
    expect(list).toEqual([])
  })

  it('keeps the channel for an admin regardless of the granted set (implicit access)', () => {
    const queryClient = setup('admin', [privateChannel()])
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    fireSse('channel.access_updated', {
      serverId: SERVER_ID,
      channelId: CHANNEL_ID,
      authorizedRoles: [],
    })

    const list = queryClient.getQueryData<ChannelResponse[]>(queryKeys.channels.byServer(SERVER_ID))
    expect(list?.map((c) => c.id)).toEqual([CHANNEL_ID])
    // Already present + qualifies → no refetch needed.
    expect(invalidateSpy).not.toHaveBeenCalled()
  })

  it('warns and skips on a malformed payload', () => {
    setup('member', [privateChannel()])

    fireSse('channel.access_updated', { serverId: SERVER_ID })

    expect(logger.warn).toHaveBeenCalledOnce()
  })
})

describe('useRealtimeChannels — channel.updated', () => {
  it('appends a channel missing from the cache (private→public becomes visible)', () => {
    const queryClient = setup('member', [])

    fireSse('channel.updated', {
      serverId: SERVER_ID,
      channel: { ...privateChannel(), isPrivate: false },
    })

    const list = queryClient.getQueryData<ChannelResponse[]>(queryKeys.channels.byServer(SERVER_ID))
    expect(list?.map((c) => c.id)).toEqual([CHANNEL_ID])
  })

  it('replaces an existing channel in place without duplicating it', () => {
    const queryClient = setup('member', [privateChannel()])

    fireSse('channel.updated', {
      serverId: SERVER_ID,
      channel: { ...privateChannel(), name: 'ops-renamed' },
    })

    const list = queryClient.getQueryData<ChannelResponse[]>(queryKeys.channels.byServer(SERVER_ID))
    expect(list).toHaveLength(1)
    expect(list?.[0]?.name).toBe('ops-renamed')
  })

  it('never appends a PRIVATE channel missing from the cache (backend fail-open must not leak it)', () => {
    const queryClient = setup('member', [])

    fireSse('channel.updated', {
      serverId: SERVER_ID,
      channel: { ...privateChannel(), isPrivate: true },
    })

    const list = queryClient.getQueryData<ChannelResponse[]>(queryKeys.channels.byServer(SERVER_ID))
    expect(list).toEqual([])
  })
})

describe('useRealtimeChannels — member.role_updated', () => {
  it('invalidates the channel list when MY role changes (revoke/grant via role)', () => {
    const queryClient = setup('member', [privateChannel()])
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    fireSse('member.role_updated', {
      serverId: SERVER_ID,
      member: {
        userId: ME,
        username: 'me',
        role: 'moderator',
        joinedAt: '2026-03-16T00:00:00.000Z',
      },
    })

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.channels.byServer(SERVER_ID),
    })
  })

  it("ignores another member's role change", () => {
    const queryClient = setup('member', [privateChannel()])
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    fireSse('member.role_updated', {
      serverId: SERVER_ID,
      member: {
        userId: 'someone-else',
        username: 'other',
        role: 'moderator',
        joinedAt: '2026-03-16T00:00:00.000Z',
      },
    })

    expect(invalidateSpy).not.toHaveBeenCalled()
  })

  it('warns and skips on a malformed member.role_updated payload', () => {
    setup('member', [privateChannel()])

    fireSse('member.role_updated', { serverId: SERVER_ID })

    expect(logger.warn).toHaveBeenCalledOnce()
  })
})
