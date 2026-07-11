import type { InfiniteData } from '@tanstack/react-query'
import { renderHook } from '@testing-library/react'
import { act } from 'react'
import { vi } from 'vitest'
import { SSE_EVENT_PREFIX } from '@/hooks/use-server-event'
import type { MessageListResponse, MessageResponse, ReactionSummary } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { createQueryWrapper, createTestQueryClient } from '@/tests/test-utils'
import { useRealtimeReactions } from './use-realtime-reactions'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

const CHANNEL_ID = 'channel-1'
const CURRENT_USER_ID = 'user-me'
const MESSAGE_ID = 'msg-1'

// -- Helpers ------------------------------------------------------------------

function buildMessage(reactions: Array<ReactionSummary>): MessageResponse {
  return {
    id: MESSAGE_ID,
    channelId: CHANNEL_ID,
    authorId: 'user-99',
    authorUsername: 'author',
    content: 'hi',
    createdAt: '2026-03-16T00:00:00.000Z',
    encrypted: false,
    messageType: 'default',
    mentions: [],
    attachments: [],
    isPinned: false,
    reactions,
  }
}

function buildCache(reactions: Array<ReactionSummary>): InfiniteData<MessageListResponse> {
  return {
    pages: [{ items: [buildMessage(reactions)], nextCursor: null }],
    pageParams: [undefined],
  }
}

function fireSSEEvent(eventName: string, payload: unknown) {
  window.dispatchEvent(new CustomEvent(`${SSE_EVENT_PREFIX}${eventName}`, { detail: payload }))
}

function reactionsInCache(
  queryClient: ReturnType<typeof createTestQueryClient>,
): Array<ReactionSummary> {
  const cache = queryClient.getQueryData<InfiniteData<MessageListResponse>>(
    queryKeys.messages.byChannel(CHANNEL_ID),
  )
  return cache?.pages[0]?.items[0]?.reactions ?? []
}

function renderReactions(queryClient: ReturnType<typeof createTestQueryClient>) {
  renderHook(() => useRealtimeReactions(CHANNEL_ID, CURRENT_USER_ID), {
    wrapper: createQueryWrapper(queryClient),
  })
}

// -- Tests --------------------------------------------------------------------

describe('useRealtimeReactions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('appends a reactor and increments the count on reaction.added (existing emoji)', () => {
    const queryClient = createTestQueryClient()
    queryClient.setQueryData(
      queryKeys.messages.byChannel(CHANNEL_ID),
      buildCache([
        { emoji: '👍', count: 1, reactedByMe: false, reactors: [{ username: 'alice' }] },
      ]),
    )
    renderReactions(queryClient)

    act(() => {
      fireSSEEvent('reaction.added', {
        channelId: CHANNEL_ID,
        messageId: MESSAGE_ID,
        emoji: '👍',
        userId: 'user-bob',
        username: 'bob',
        displayName: 'Bob B',
      })
    })

    const [summary] = reactionsInCache(queryClient)
    expect(summary?.count).toBe(2)
    expect(summary?.reactors.map((r) => r.username)).toEqual(['alice', 'bob'])
    expect(summary?.reactors[1]?.displayName).toBe('Bob B')
  })

  it('creates a new emoji summary with the reactor on reaction.added (novel emoji)', () => {
    const queryClient = createTestQueryClient()
    queryClient.setQueryData(queryKeys.messages.byChannel(CHANNEL_ID), buildCache([]))
    renderReactions(queryClient)

    act(() => {
      fireSSEEvent('reaction.added', {
        channelId: CHANNEL_ID,
        messageId: MESSAGE_ID,
        emoji: '🎉',
        userId: 'user-carol',
        username: 'carol',
        displayName: null,
      })
    })

    const [summary] = reactionsInCache(queryClient)
    expect(summary).toMatchObject({ emoji: '🎉', count: 1 })
    expect(summary?.reactors).toEqual([{ username: 'carol', displayName: null }])
  })

  it('does not duplicate a reactor when the same username reacts again (idempotent echo)', () => {
    const queryClient = createTestQueryClient()
    queryClient.setQueryData(
      queryKeys.messages.byChannel(CHANNEL_ID),
      buildCache([
        { emoji: '👍', count: 1, reactedByMe: false, reactors: [{ username: 'alice' }] },
      ]),
    )
    renderReactions(queryClient)

    act(() => {
      fireSSEEvent('reaction.added', {
        channelId: CHANNEL_ID,
        messageId: MESSAGE_ID,
        emoji: '👍',
        userId: 'user-alice',
        username: 'alice',
        displayName: 'Alice',
      })
    })

    const [summary] = reactionsInCache(queryClient)
    // Count still advances, but the name is not appended twice.
    expect(summary?.reactors).toHaveLength(1)
    expect(summary?.reactors[0]?.username).toBe('alice')
  })

  it('caps the reactor list at 10 while still counting the 11th reactor', () => {
    const queryClient = createTestQueryClient()
    const tenReactors = Array.from({ length: 10 }, (_, i) => ({ username: `u${i}` }))
    queryClient.setQueryData(
      queryKeys.messages.byChannel(CHANNEL_ID),
      buildCache([{ emoji: '👍', count: 10, reactedByMe: false, reactors: tenReactors }]),
    )
    renderReactions(queryClient)

    act(() => {
      fireSSEEvent('reaction.added', {
        channelId: CHANNEL_ID,
        messageId: MESSAGE_ID,
        emoji: '👍',
        userId: 'user-11',
        username: 'eleventh',
        displayName: 'Eleventh',
      })
    })

    const [summary] = reactionsInCache(queryClient)
    expect(summary?.count).toBe(11)
    expect(summary?.reactors).toHaveLength(10)
    expect(summary?.reactors.some((r) => r.username === 'eleventh')).toBe(false)
  })

  it('removes the reactor by username and decrements the count on reaction.removed', () => {
    const queryClient = createTestQueryClient()
    queryClient.setQueryData(
      queryKeys.messages.byChannel(CHANNEL_ID),
      buildCache([
        {
          emoji: '👍',
          count: 2,
          reactedByMe: false,
          reactors: [{ username: 'alice' }, { username: 'bob' }],
        },
      ]),
    )
    renderReactions(queryClient)

    act(() => {
      fireSSEEvent('reaction.removed', {
        channelId: CHANNEL_ID,
        messageId: MESSAGE_ID,
        emoji: '👍',
        userId: 'user-bob',
        username: 'bob',
      })
    })

    const [summary] = reactionsInCache(queryClient)
    expect(summary?.count).toBe(1)
    expect(summary?.reactors.map((r) => r.username)).toEqual(['alice'])
  })

  it('drops the emoji summary entirely when the last reactor leaves', () => {
    const queryClient = createTestQueryClient()
    queryClient.setQueryData(
      queryKeys.messages.byChannel(CHANNEL_ID),
      buildCache([{ emoji: '👍', count: 1, reactedByMe: true, reactors: [{ username: 'me' }] }]),
    )
    renderReactions(queryClient)

    act(() => {
      fireSSEEvent('reaction.removed', {
        channelId: CHANNEL_ID,
        messageId: MESSAGE_ID,
        emoji: '👍',
        userId: CURRENT_USER_ID,
        username: 'me',
      })
    })

    expect(reactionsInCache(queryClient)).toHaveLength(0)
  })
})
