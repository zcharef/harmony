import type { InfiniteData } from '@tanstack/react-query'
import { renderHook } from '@testing-library/react'
import { act } from 'react'
import { vi } from 'vitest'
import { SSE_EVENT_PREFIX } from '@/hooks/use-server-event'
import type { MessageListResponse, MessageResponse } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { createQueryWrapper, createTestQueryClient } from '@/tests/test-utils'
import { useRealtimeMessages } from './use-realtime-messages'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

const { logger } = await import('@/lib/logger')

const CHANNEL_ID = 'channel-1'

// -- Helpers ------------------------------------------------------------------

function buildMessage(overrides: Partial<MessageResponse> = {}): MessageResponse {
  return {
    id: 'msg-1',
    channelId: CHANNEL_ID,
    authorId: 'user-99',
    authorUsername: 'testuser',
    authorAvatarUrl: null,
    content: 'existing message',
    createdAt: '2026-03-16T00:00:00.000Z',
    encrypted: false,
    messageType: 'default',
    ...overrides,
  }
}

function buildCacheData(messages: MessageResponse[]): InfiniteData<MessageListResponse> {
  return {
    pages: [{ items: messages, nextCursor: null }],
    pageParams: [undefined],
  }
}

/**
 * Dispatches a CustomEvent on window to simulate an SSE event arriving.
 * This is the real integration path — useServerEvent listens on window.
 */
function fireSSEEvent(eventName: string, payload: unknown) {
  const event = new CustomEvent(`${SSE_EVENT_PREFIX}${eventName}`, {
    detail: payload,
  })
  window.dispatchEvent(event)
}

/** Valid camelCase SSE message payload as the Rust API delivers it */
function buildMessagePayload(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-new',
    channelId: CHANNEL_ID,
    content: 'hello world',
    authorId: 'user-42',
    authorUsername: 'alice',
    authorAvatarUrl: null,
    encrypted: false,
    senderDeviceId: null,
    editedAt: null,
    messageType: 'default',
    createdAt: '2026-03-16T01:00:00.000Z',
    ...overrides,
  }
}

/** Wraps an SSE message payload in the event envelope (channelId + message) */
function buildMessageEvent(messageOverrides: Record<string, unknown> = {}) {
  const message = buildMessagePayload(messageOverrides)
  return {
    channelId: message.channelId,
    message,
  }
}

// -- Tests --------------------------------------------------------------------

describe('useRealtimeMessages', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // -- message.created: valid payload prepends to first page ------------------

  it('prepends a new message to page 0 on message.created', () => {
    const queryClient = createTestQueryClient()
    const messageKey = queryKeys.messages.byChannel(CHANNEL_ID)
    const existingMsg = buildMessage({ id: 'existing-1' })
    queryClient.setQueryData(messageKey, buildCacheData([existingMsg]))

    renderHook(() => useRealtimeMessages(CHANNEL_ID), {
      wrapper: createQueryWrapper(queryClient),
    })

    act(() => {
      fireSSEEvent('message.created', buildMessageEvent({ id: 'msg-new' }))
    })

    const cacheData = queryClient.getQueryData<InfiniteData<MessageListResponse>>(messageKey)
    const items = cacheData?.pages[0]?.items ?? []
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      id: 'msg-new',
      channelId: CHANNEL_ID,
      authorId: 'user-42',
      authorUsername: 'alice',
      content: 'hello world',
    })
    expect(items[1]?.id).toBe('existing-1')
  })

  // -- message.created dedup: duplicate ID is not inserted --------------------

  it('does not insert a duplicate message on message.created with existing ID', () => {
    const queryClient = createTestQueryClient()
    const messageKey = queryKeys.messages.byChannel(CHANNEL_ID)
    const existingMsg = buildMessage({ id: 'msg-dup' })
    queryClient.setQueryData(messageKey, buildCacheData([existingMsg]))

    renderHook(() => useRealtimeMessages(CHANNEL_ID), {
      wrapper: createQueryWrapper(queryClient),
    })

    act(() => {
      fireSSEEvent('message.created', buildMessageEvent({ id: 'msg-dup' }))
    })

    const cacheData = queryClient.getQueryData<InfiniteData<MessageListResponse>>(messageKey)
    const items = cacheData?.pages[0]?.items ?? []
    expect(items).toHaveLength(1)
    expect(items[0]?.id).toBe('msg-dup')
  })

  // -- message.created: filters by channelId ----------------------------------

  it('ignores message.created events for a different channel', () => {
    const queryClient = createTestQueryClient()
    const messageKey = queryKeys.messages.byChannel(CHANNEL_ID)
    queryClient.setQueryData(messageKey, buildCacheData([]))

    renderHook(() => useRealtimeMessages(CHANNEL_ID), {
      wrapper: createQueryWrapper(queryClient),
    })

    act(() => {
      fireSSEEvent('message.created', {
        channelId: 'other-channel',
        message: buildMessagePayload({ channelId: 'other-channel' }),
      })
    })

    const cacheData = queryClient.getQueryData<InfiniteData<MessageListResponse>>(messageKey)
    expect(cacheData?.pages[0]?.items).toHaveLength(0)
  })

  // -- message.created: malformed payload logs error --------------------------

  it('logs error and does not update cache when message.created payload is malformed', () => {
    const queryClient = createTestQueryClient()
    const messageKey = queryKeys.messages.byChannel(CHANNEL_ID)
    const initialData = buildCacheData([buildMessage()])
    queryClient.setQueryData(messageKey, initialData)

    renderHook(() => useRealtimeMessages(CHANNEL_ID), {
      wrapper: createQueryWrapper(queryClient),
    })

    act(() => {
      fireSSEEvent('message.created', { channelId: CHANNEL_ID, message: { id: 'bad' } })
    })

    expect(logger.error).toHaveBeenCalledOnce()
    expect(logger.error).toHaveBeenCalledWith(
      'Malformed message.created SSE payload',
      expect.objectContaining({ channelId: CHANNEL_ID }),
    )

    const cacheData = queryClient.getQueryData<InfiniteData<MessageListResponse>>(messageKey)
    expect(cacheData?.pages[0]?.items).toHaveLength(1)
    expect(cacheData?.pages[0]?.items[0]?.id).toBe('msg-1')
  })

  // -- message.updated: replaces message content in cache ---------------------

  it('replaces message content in cache on message.updated', () => {
    const queryClient = createTestQueryClient()
    const messageKey = queryKeys.messages.byChannel(CHANNEL_ID)
    const existingMsg = buildMessage({ id: 'msg-edit', content: 'original' })
    queryClient.setQueryData(messageKey, buildCacheData([existingMsg]))

    renderHook(() => useRealtimeMessages(CHANNEL_ID), {
      wrapper: createQueryWrapper(queryClient),
    })

    act(() => {
      fireSSEEvent(
        'message.updated',
        buildMessageEvent({
          id: 'msg-edit',
          content: 'edited content',
          editedAt: '2026-03-16T02:00:00.000Z',
        }),
      )
    })

    const cacheData = queryClient.getQueryData<InfiniteData<MessageListResponse>>(messageKey)
    const items = cacheData?.pages[0]?.items ?? []
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: 'msg-edit',
      content: 'edited content',
      editedAt: '2026-03-16T02:00:00.000Z',
    })
  })

  // -- message.updated: malformed payload logs error --------------------------

  it('logs error and does not update cache when message.updated payload is malformed', () => {
    const queryClient = createTestQueryClient()
    const messageKey = queryKeys.messages.byChannel(CHANNEL_ID)
    const existingMsg = buildMessage({ id: 'msg-1' })
    queryClient.setQueryData(messageKey, buildCacheData([existingMsg]))

    renderHook(() => useRealtimeMessages(CHANNEL_ID), {
      wrapper: createQueryWrapper(queryClient),
    })

    act(() => {
      fireSSEEvent('message.updated', { channelId: CHANNEL_ID, message: { id: 42 } })
    })

    expect(logger.error).toHaveBeenCalledOnce()
    expect(logger.error).toHaveBeenCalledWith(
      'Malformed message.updated SSE payload',
      expect.objectContaining({ channelId: CHANNEL_ID }),
    )

    const cacheData = queryClient.getQueryData<InfiniteData<MessageListResponse>>(messageKey)
    expect(cacheData?.pages[0]?.items).toHaveLength(1)
  })

  // -- message.deleted: soft-delete sets deletedBy ----------------------------

  it('sets deletedBy on the message on message.deleted', () => {
    const queryClient = createTestQueryClient()
    const messageKey = queryKeys.messages.byChannel(CHANNEL_ID)
    const existingMsg = buildMessage({ id: 'msg-del', authorId: 'user-42' })
    queryClient.setQueryData(messageKey, buildCacheData([existingMsg]))

    renderHook(() => useRealtimeMessages(CHANNEL_ID), {
      wrapper: createQueryWrapper(queryClient),
    })

    act(() => {
      fireSSEEvent('message.deleted', {
        channelId: CHANNEL_ID,
        messageId: 'msg-del',
      })
    })

    const cacheData = queryClient.getQueryData<InfiniteData<MessageListResponse>>(messageKey)
    const items = cacheData?.pages[0]?.items ?? []
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: 'msg-del',
      deletedBy: 'user-42',
    })
  })

  // -- message.deleted: marks parentMessage as deleted on child messages ------

  it('marks parentMessage as deleted on child messages when parent is deleted', () => {
    const queryClient = createTestQueryClient()
    const messageKey = queryKeys.messages.byChannel(CHANNEL_ID)
    const parentMsg = buildMessage({ id: 'msg-parent', authorId: 'user-42' })
    const childMsg = buildMessage({
      id: 'msg-child',
      authorId: 'user-99',
      parentMessage: {
        id: 'msg-parent',
        authorUsername: 'alice',
        contentPreview: 'hello world',
        deleted: false,
      },
    })
    queryClient.setQueryData(messageKey, buildCacheData([parentMsg, childMsg]))

    renderHook(() => useRealtimeMessages(CHANNEL_ID), {
      wrapper: createQueryWrapper(queryClient),
    })

    act(() => {
      fireSSEEvent('message.deleted', {
        channelId: CHANNEL_ID,
        messageId: 'msg-parent',
      })
    })

    const cacheData = queryClient.getQueryData<InfiniteData<MessageListResponse>>(messageKey)
    const items = cacheData?.pages[0]?.items ?? []
    expect(items).toHaveLength(2)
    // Parent is soft-deleted
    expect(items[0]).toMatchObject({ id: 'msg-parent', deletedBy: 'user-42' })
    // Child's parentMessage is marked deleted with cleared content
    expect(items[1]?.parentMessage).toMatchObject({
      id: 'msg-parent',
      deleted: true,
      contentPreview: '',
      authorUsername: '',
    })
  })

  it('marks parentMessage as deleted on multiple child messages quoting the same parent', () => {
    const queryClient = createTestQueryClient()
    const messageKey = queryKeys.messages.byChannel(CHANNEL_ID)
    const parentMsg = buildMessage({ id: 'msg-parent', authorId: 'user-42' })
    const parentPreview = {
      id: 'msg-parent',
      authorUsername: 'alice',
      contentPreview: 'hello',
      deleted: false,
    }
    const childA = buildMessage({ id: 'msg-child-a', parentMessage: parentPreview })
    const childB = buildMessage({ id: 'msg-child-b', parentMessage: parentPreview })
    queryClient.setQueryData(messageKey, buildCacheData([parentMsg, childA, childB]))

    renderHook(() => useRealtimeMessages(CHANNEL_ID), {
      wrapper: createQueryWrapper(queryClient),
    })

    act(() => {
      fireSSEEvent('message.deleted', {
        channelId: CHANNEL_ID,
        messageId: 'msg-parent',
      })
    })

    const cacheData = queryClient.getQueryData<InfiniteData<MessageListResponse>>(messageKey)
    const items = cacheData?.pages[0]?.items ?? []
    expect(items[1]?.parentMessage?.deleted).toBe(true)
    expect(items[2]?.parentMessage?.deleted).toBe(true)
  })

  // -- message.deleted: malformed payload logs error --------------------------

  it('logs error and does not update cache when message.deleted payload is malformed', () => {
    const queryClient = createTestQueryClient()
    const messageKey = queryKeys.messages.byChannel(CHANNEL_ID)
    const existingMsg = buildMessage({ id: 'msg-1' })
    queryClient.setQueryData(messageKey, buildCacheData([existingMsg]))

    renderHook(() => useRealtimeMessages(CHANNEL_ID), {
      wrapper: createQueryWrapper(queryClient),
    })

    act(() => {
      fireSSEEvent('message.deleted', { bad: 'data' })
    })

    expect(logger.error).toHaveBeenCalledOnce()
    expect(logger.error).toHaveBeenCalledWith(
      'Malformed message.deleted SSE payload',
      expect.objectContaining({ channelId: CHANNEL_ID }),
    )

    const cacheData = queryClient.getQueryData<InfiniteData<MessageListResponse>>(messageKey)
    expect(cacheData?.pages[0]?.items).toHaveLength(1)
  })

  // -- Empty channelId: no subscription ---------------------------------------

  it('does not process events when channelId is empty', () => {
    const queryClient = createTestQueryClient()

    renderHook(() => useRealtimeMessages(''), {
      wrapper: createQueryWrapper(queryClient),
    })

    act(() => {
      fireSSEEvent('message.created', buildMessageEvent())
    })

    // No cache key exists, and no errors should have been logged
    expect(logger.error).not.toHaveBeenCalled()
  })

  // -- No-op when cache is empty (undefined) ----------------------------------

  it('does not crash on message.created when cache has no data', () => {
    const queryClient = createTestQueryClient()
    // Intentionally do NOT seed the cache

    renderHook(() => useRealtimeMessages(CHANNEL_ID), {
      wrapper: createQueryWrapper(queryClient),
    })

    act(() => {
      fireSSEEvent('message.created', buildMessageEvent())
    })

    const messageKey = queryKeys.messages.byChannel(CHANNEL_ID)
    const cacheData = queryClient.getQueryData<InfiniteData<MessageListResponse>>(messageKey)
    expect(cacheData).toBeUndefined()
  })
})
