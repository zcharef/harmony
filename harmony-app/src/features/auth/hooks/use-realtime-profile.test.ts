import type { InfiniteData } from '@tanstack/react-query'
import { renderHook } from '@testing-library/react'
import { act } from 'react'
import { vi } from 'vitest'
import { SSE_EVENT_PREFIX } from '@/hooks/use-server-event'
import type {
  DmListItem,
  MemberListResponse,
  MessageListResponse,
  MessageResponse,
  ProfileResponse,
} from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { createQueryWrapper, createTestQueryClient } from '@/tests/test-utils'
import { useRealtimeProfile } from './use-realtime-profile'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

const { logger } = await import('@/lib/logger')

const SUBJECT_ID = 'user-subject'
const OTHER_ID = 'user-other'
const SERVER_A = 'server-a'
const SERVER_B = 'server-b'
const CHANNEL_1 = 'channel-1'

// -- Helpers ------------------------------------------------------------------

function fireSSEEvent(eventName: string, payload: unknown) {
  const event = new CustomEvent(`${SSE_EVENT_PREFIX}${eventName}`, { detail: payload })
  window.dispatchEvent(event)
}

function buildMemberList(): MemberListResponse {
  return {
    items: [
      {
        userId: SUBJECT_ID,
        username: 'subject',
        displayName: 'Old Name',
        avatarUrl: 'https://cdn.example.com/old.webp',
        nickname: 'ServerNick',
        role: 'member',
        joinedAt: '2026-03-01T00:00:00Z',
      },
      {
        userId: OTHER_ID,
        username: 'other',
        displayName: 'Other',
        avatarUrl: null,
        nickname: null,
        role: 'member',
        joinedAt: '2026-03-02T00:00:00Z',
      },
    ],
    nextCursor: null,
  }
}

function buildDmList(): DmListItem[] {
  return [
    {
      channelId: 'dm-channel',
      serverId: 'dm-server',
      recipient: {
        id: SUBJECT_ID,
        username: 'subject',
        displayName: 'Old Name',
        avatarUrl: 'https://cdn.example.com/old.webp',
      },
    },
    {
      channelId: 'dm-channel-2',
      serverId: 'dm-server-2',
      recipient: { id: OTHER_ID, username: 'other', displayName: 'Other', avatarUrl: null },
    },
  ]
}

function buildMessage(overrides: Partial<MessageResponse> = {}): MessageResponse {
  return {
    id: 'msg-1',
    channelId: CHANNEL_1,
    authorId: SUBJECT_ID,
    authorUsername: 'subject',
    authorDisplayName: 'Old Name',
    authorAvatarUrl: 'https://cdn.example.com/old.webp',
    content: 'hello',
    createdAt: '2026-03-16T00:00:00.000Z',
    encrypted: false,
    messageType: 'default',
    mentions: [],
    ...overrides,
  }
}

function buildMessageCache(messages: MessageResponse[]): InfiniteData<MessageListResponse> {
  return { pages: [{ items: messages, nextCursor: null }], pageParams: [undefined] }
}

function buildProfile(): ProfileResponse {
  return {
    id: SUBJECT_ID,
    username: 'subject',
    displayName: 'Old Name',
    avatarUrl: 'https://cdn.example.com/old.webp',
    customStatus: 'old status',
    status: 'online',
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-01T00:00:00Z',
  }
}

function buildEvent(overrides: Record<string, unknown> = {}) {
  return {
    userId: SUBJECT_ID,
    displayName: 'New Name',
    avatarUrl: 'https://cdn.example.com/new.webp',
    customStatus: 'new status',
    ...overrides,
  }
}

// -- Tests --------------------------------------------------------------------

describe('useRealtimeProfile', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('patches the subject across every cached server member list, leaving nickname untouched', () => {
    const queryClient = createTestQueryClient()
    queryClient.setQueryData(queryKeys.servers.members(SERVER_A), buildMemberList())
    queryClient.setQueryData(queryKeys.servers.members(SERVER_B), buildMemberList())

    renderHook(() => useRealtimeProfile(OTHER_ID), {
      wrapper: createQueryWrapper(queryClient),
    })

    act(() => {
      fireSSEEvent('profile.updated', buildEvent())
    })

    for (const serverId of [SERVER_A, SERVER_B]) {
      const data = queryClient.getQueryData<MemberListResponse>(queryKeys.servers.members(serverId))
      const subject = data?.items.find((m) => m.userId === SUBJECT_ID)
      expect(subject?.displayName).toBe('New Name')
      expect(subject?.avatarUrl).toBe('https://cdn.example.com/new.webp')
      // Per-server nickname must NOT be overwritten by an account-level change.
      expect(subject?.nickname).toBe('ServerNick')
      // Untouched members stay put.
      const other = data?.items.find((m) => m.userId === OTHER_ID)
      expect(other?.displayName).toBe('Other')
    }
  })

  it('patches the DM recipient where the subject is the recipient', () => {
    const queryClient = createTestQueryClient()
    queryClient.setQueryData(queryKeys.dms.list(), buildDmList())

    renderHook(() => useRealtimeProfile(OTHER_ID), {
      wrapper: createQueryWrapper(queryClient),
    })

    act(() => {
      fireSSEEvent('profile.updated', buildEvent())
    })

    const data = queryClient.getQueryData<DmListItem[]>(queryKeys.dms.list())
    expect(data?.[0]?.recipient.displayName).toBe('New Name')
    expect(data?.[0]?.recipient.avatarUrl).toBe('https://cdn.example.com/new.webp')
    // The other DM is unchanged.
    expect(data?.[1]?.recipient.displayName).toBe('Other')
  })

  it('patches authorDisplayName + authorAvatarUrl on the subject-authored messages', () => {
    const queryClient = createTestQueryClient()
    const messageKey = queryKeys.messages.byChannel(CHANNEL_1)
    queryClient.setQueryData(
      messageKey,
      buildMessageCache([
        buildMessage({ id: 'm1' }),
        buildMessage({ id: 'm2', authorId: OTHER_ID, authorDisplayName: 'Other' }),
      ]),
    )

    renderHook(() => useRealtimeProfile(OTHER_ID), {
      wrapper: createQueryWrapper(queryClient),
    })

    act(() => {
      fireSSEEvent('profile.updated', buildEvent())
    })

    const data = queryClient.getQueryData<InfiniteData<MessageListResponse>>(messageKey)
    const items = data?.pages[0]?.items ?? []
    expect(items[0]).toMatchObject({
      id: 'm1',
      authorDisplayName: 'New Name',
      authorAvatarUrl: 'https://cdn.example.com/new.webp',
    })
    // A different author is untouched.
    expect(items[1]).toMatchObject({ id: 'm2', authorDisplayName: 'Other' })
  })

  it('patches the own-profile cache (incl. customStatus) when the subject is the current user', () => {
    const queryClient = createTestQueryClient()
    queryClient.setQueryData(queryKeys.profiles.me(), buildProfile())

    renderHook(() => useRealtimeProfile(SUBJECT_ID), {
      wrapper: createQueryWrapper(queryClient),
    })

    act(() => {
      fireSSEEvent('profile.updated', buildEvent())
    })

    const data = queryClient.getQueryData<ProfileResponse>(queryKeys.profiles.me())
    expect(data?.displayName).toBe('New Name')
    expect(data?.avatarUrl).toBe('https://cdn.example.com/new.webp')
    expect(data?.customStatus).toBe('new status')
    // Non-identity fields survive.
    expect(data?.username).toBe('subject')
  })

  it('does NOT patch the own-profile cache when the subject is a different user', () => {
    const queryClient = createTestQueryClient()
    queryClient.setQueryData(queryKeys.profiles.me(), buildProfile())

    renderHook(() => useRealtimeProfile(OTHER_ID), {
      wrapper: createQueryWrapper(queryClient),
    })

    act(() => {
      fireSSEEvent('profile.updated', buildEvent())
    })

    const data = queryClient.getQueryData<ProfileResponse>(queryKeys.profiles.me())
    expect(data?.displayName).toBe('Old Name')
    expect(data?.customStatus).toBe('old status')
  })

  it('writes null when the subject cleared their display name and avatar', () => {
    const queryClient = createTestQueryClient()
    queryClient.setQueryData(queryKeys.servers.members(SERVER_A), buildMemberList())

    renderHook(() => useRealtimeProfile(OTHER_ID), {
      wrapper: createQueryWrapper(queryClient),
    })

    act(() => {
      fireSSEEvent('profile.updated', buildEvent({ displayName: null, avatarUrl: null }))
    })

    const data = queryClient.getQueryData<MemberListResponse>(queryKeys.servers.members(SERVER_A))
    const subject = data?.items.find((m) => m.userId === SUBJECT_ID)
    expect(subject?.displayName).toBeNull()
    expect(subject?.avatarUrl).toBeNull()
  })

  it('logs an error and leaves caches untouched on a malformed payload', () => {
    const queryClient = createTestQueryClient()
    queryClient.setQueryData(queryKeys.servers.members(SERVER_A), buildMemberList())

    renderHook(() => useRealtimeProfile(OTHER_ID), {
      wrapper: createQueryWrapper(queryClient),
    })

    act(() => {
      fireSSEEvent('profile.updated', { userId: 42 })
    })

    expect(logger.error).toHaveBeenCalledOnce()
    expect(logger.error).toHaveBeenCalledWith(
      'Malformed profile.updated SSE payload',
      expect.objectContaining({ error: expect.any(String) }),
    )
    const data = queryClient.getQueryData<MemberListResponse>(queryKeys.servers.members(SERVER_A))
    expect(data?.items.find((m) => m.userId === SUBJECT_ID)?.displayName).toBe('Old Name')
  })

  it('does not create a phantom cache entry for an un-fetched server', () => {
    const queryClient = createTestQueryClient()
    // No member list seeded.

    renderHook(() => useRealtimeProfile(OTHER_ID), {
      wrapper: createQueryWrapper(queryClient),
    })

    act(() => {
      fireSSEEvent('profile.updated', buildEvent())
    })

    expect(queryClient.getQueryData(queryKeys.servers.members(SERVER_A))).toBeUndefined()
  })
})
