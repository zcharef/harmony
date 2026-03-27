import type { InfiniteData } from '@tanstack/react-query'
import { renderHook } from '@testing-library/react'
import { vi } from 'vitest'
import type { MessageListResponse, MessageResponse } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { createQueryWrapper, createTestQueryClient } from '@/tests/test-utils'
import { useRealtimeMessages } from './use-realtime-messages'

vi.mock('@/lib/supabase', () => ({
  supabase: {
    channel: vi.fn(),
    removeChannel: vi.fn(),
  },
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

const { supabase } = await import('@/lib/supabase')
const { logger } = await import('@/lib/logger')

const CHANNEL_ID = 'channel-1'

// -- Helpers ------------------------------------------------------------------

function buildMessage(overrides: Partial<MessageResponse> = {}): MessageResponse {
  return {
    id: 'msg-1',
    channelId: CHANNEL_ID,
    authorId: 'user-99',
    authorUsername: 'testuser',
    content: 'existing message',
    createdAt: '2026-03-16T00:00:00.000Z',
    encrypted: false,
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
 * Creates a mock Supabase Realtime channel that captures `.on()` callbacks
 * so tests can invoke them directly without a real WebSocket.
 */
function createMockChannel() {
  const handlers: Record<string, (payload: unknown) => void> = {}
  const channel = {
    on: vi.fn((type: string, filter: { event: string }, callback: (payload: unknown) => void) => {
      const key = `${type}:${filter.event}`
      handlers[key] = callback
      return channel
    }),
    subscribe: vi.fn(() => channel),
  }
  return { channel, handlers }
}

/** Fires the captured INSERT handler with a given payload.new */
function fireInsert(handlers: Record<string, (payload: unknown) => void>, row: unknown) {
  const handler = handlers['postgres_changes:INSERT']
  if (!handler) throw new Error('INSERT handler not registered')
  handler({ new: row })
}

/** Fires the captured UPDATE handler with a given payload.new */
function fireUpdate(handlers: Record<string, (payload: unknown) => void>, row: unknown) {
  const handler = handlers['postgres_changes:UPDATE']
  if (!handler) throw new Error('UPDATE handler not registered')
  handler({ new: row })
}

/** Valid snake_case row as Supabase Realtime delivers it */
function buildRealtimeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-new',
    channel_id: CHANNEL_ID,
    author_id: 'user-42',
    content: 'hello world',
    created_at: '2026-03-16T01:00:00.000Z',
    edited_at: null,
    deleted_at: null,
    deleted_by: null,
    ...overrides,
  }
}

// -- Tests --------------------------------------------------------------------

describe('useRealtimeMessages', () => {
  let mockChannel: ReturnType<typeof createMockChannel>

  beforeEach(() => {
    vi.clearAllMocks()
    mockChannel = createMockChannel()
    vi.mocked(supabase.channel).mockReturnValue(mockChannel.channel as never)
  })

  // -- Schema validation (INSERT) -------------------------------------------

  it('logs error and does not update cache when INSERT payload is malformed', () => {
    const queryClient = createTestQueryClient()
    const messageKey = queryKeys.messages.byChannel(CHANNEL_ID)
    const initialData = buildCacheData([buildMessage()])
    queryClient.setQueryData(messageKey, initialData)

    renderHook(() => useRealtimeMessages(CHANNEL_ID), {
      wrapper: createQueryWrapper(queryClient),
    })

    // Fire an INSERT with missing required fields
    fireInsert(mockChannel.handlers, { id: 'bad', content: 123 })

    expect(logger.error).toHaveBeenCalledOnce()
    expect(logger.error).toHaveBeenCalledWith(
      'Malformed realtime message payload',
      expect.objectContaining({ channelId: CHANNEL_ID }),
    )

    // Cache must be unchanged
    const cacheData = queryClient.getQueryData<InfiniteData<MessageListResponse>>(messageKey)
    expect(cacheData?.pages[0]?.items).toHaveLength(1)
    expect(cacheData?.pages[0]?.items[0]?.id).toBe('msg-1')
  })

  // -- INSERT: valid payload prepends to first page --------------------------

  it('subscribes to the correct table, schema, and channel filter', () => {
    const queryClient = createTestQueryClient()
    queryClient.setQueryData(queryKeys.messages.byChannel(CHANNEL_ID), buildCacheData([]))

    renderHook(() => useRealtimeMessages(CHANNEL_ID), {
      wrapper: createQueryWrapper(queryClient),
    })

    expect(supabase.channel).toHaveBeenCalledWith(`messages:${CHANNEL_ID}`)
    expect(mockChannel.channel.on).toHaveBeenCalledWith(
      'postgres_changes',
      expect.objectContaining({
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: `channel_id=eq.${CHANNEL_ID}`,
      }),
      expect.any(Function),
    )
    expect(mockChannel.channel.on).toHaveBeenCalledWith(
      'postgres_changes',
      expect.objectContaining({
        event: 'UPDATE',
        schema: 'public',
        table: 'messages',
        filter: `channel_id=eq.${CHANNEL_ID}`,
      }),
      expect.any(Function),
    )
  })

  it('prepends a new message to page 0 on valid INSERT', () => {
    const queryClient = createTestQueryClient()
    const messageKey = queryKeys.messages.byChannel(CHANNEL_ID)
    const existingMsg = buildMessage({ id: 'existing-1' })
    queryClient.setQueryData(messageKey, buildCacheData([existingMsg]))

    renderHook(() => useRealtimeMessages(CHANNEL_ID), {
      wrapper: createQueryWrapper(queryClient),
    })

    fireInsert(mockChannel.handlers, buildRealtimeRow({ id: 'msg-new' }))

    const cacheData = queryClient.getQueryData<InfiniteData<MessageListResponse>>(messageKey)
    const items = cacheData?.pages[0]?.items ?? []
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      id: 'msg-new',
      channelId: CHANNEL_ID,
      authorId: 'user-42',
      content: 'hello world',
    })
    expect(items[1]?.id).toBe('existing-1')
  })

  // -- INSERT dedup: duplicate ID is not inserted again ----------------------

  it('does not insert a duplicate message on INSERT with existing ID', () => {
    const queryClient = createTestQueryClient()
    const messageKey = queryKeys.messages.byChannel(CHANNEL_ID)
    const existingMsg = buildMessage({ id: 'msg-dup' })
    queryClient.setQueryData(messageKey, buildCacheData([existingMsg]))

    renderHook(() => useRealtimeMessages(CHANNEL_ID), {
      wrapper: createQueryWrapper(queryClient),
    })

    fireInsert(mockChannel.handlers, buildRealtimeRow({ id: 'msg-dup' }))

    const cacheData = queryClient.getQueryData<InfiniteData<MessageListResponse>>(messageKey)
    const items = cacheData?.pages[0]?.items ?? []
    expect(items).toHaveLength(1)
    expect(items[0]?.id).toBe('msg-dup')
  })

  // -- UPDATE (edit): replaces message content in cache ----------------------

  it('replaces message content in cache on UPDATE', () => {
    const queryClient = createTestQueryClient()
    const messageKey = queryKeys.messages.byChannel(CHANNEL_ID)
    const existingMsg = buildMessage({ id: 'msg-edit', content: 'original' })
    queryClient.setQueryData(messageKey, buildCacheData([existingMsg]))

    renderHook(() => useRealtimeMessages(CHANNEL_ID), {
      wrapper: createQueryWrapper(queryClient),
    })

    fireUpdate(
      mockChannel.handlers,
      buildRealtimeRow({
        id: 'msg-edit',
        content: 'edited content',
        edited_at: '2026-03-16T02:00:00.000Z',
        deleted_at: null,
      }),
    )

    const cacheData = queryClient.getQueryData<InfiniteData<MessageListResponse>>(messageKey)
    const items = cacheData?.pages[0]?.items ?? []
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: 'msg-edit',
      content: 'edited content',
      editedAt: '2026-03-16T02:00:00.000Z',
    })
  })

  // -- UPDATE (soft delete): keeps tombstone in cache with deletedBy ---------

  it('keeps message as tombstone with deletedBy on self-delete', () => {
    const queryClient = createTestQueryClient()
    const messageKey = queryKeys.messages.byChannel(CHANNEL_ID)
    const existingMsg = buildMessage({ id: 'msg-del', authorId: 'user-42' })
    queryClient.setQueryData(messageKey, buildCacheData([existingMsg]))

    renderHook(() => useRealtimeMessages(CHANNEL_ID), {
      wrapper: createQueryWrapper(queryClient),
    })

    fireUpdate(
      mockChannel.handlers,
      buildRealtimeRow({
        id: 'msg-del',
        author_id: 'user-42',
        deleted_at: '2026-03-16T03:00:00.000Z',
        deleted_by: 'user-42',
      }),
    )

    const cacheData = queryClient.getQueryData<InfiniteData<MessageListResponse>>(messageKey)
    const items = cacheData?.pages[0]?.items ?? []
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: 'msg-del',
      deletedBy: 'user-42',
    })
  })

  it('keeps message as tombstone with deletedBy on moderator-delete', () => {
    const queryClient = createTestQueryClient()
    const messageKey = queryKeys.messages.byChannel(CHANNEL_ID)
    const existingMsg = buildMessage({ id: 'msg-mod-del', authorId: 'user-42' })
    queryClient.setQueryData(messageKey, buildCacheData([existingMsg]))

    renderHook(() => useRealtimeMessages(CHANNEL_ID), {
      wrapper: createQueryWrapper(queryClient),
    })

    fireUpdate(
      mockChannel.handlers,
      buildRealtimeRow({
        id: 'msg-mod-del',
        author_id: 'user-42',
        deleted_at: '2026-03-16T03:00:00.000Z',
        deleted_by: 'moderator-1',
      }),
    )

    const cacheData = queryClient.getQueryData<InfiniteData<MessageListResponse>>(messageKey)
    const items = cacheData?.pages[0]?.items ?? []
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: 'msg-mod-del',
      authorId: 'user-42',
      deletedBy: 'moderator-1',
    })
  })

  // -- UPDATE (malformed): logs error and does not crash ---------------------

  it('logs error and does not update cache when UPDATE payload is malformed', () => {
    const queryClient = createTestQueryClient()
    const messageKey = queryKeys.messages.byChannel(CHANNEL_ID)
    const existingMsg = buildMessage({ id: 'msg-1' })
    queryClient.setQueryData(messageKey, buildCacheData([existingMsg]))

    renderHook(() => useRealtimeMessages(CHANNEL_ID), {
      wrapper: createQueryWrapper(queryClient),
    })

    fireUpdate(mockChannel.handlers, { id: 42 })

    expect(logger.error).toHaveBeenCalledOnce()
    expect(logger.error).toHaveBeenCalledWith(
      'Malformed realtime message update payload',
      expect.objectContaining({ channelId: CHANNEL_ID }),
    )

    const cacheData = queryClient.getQueryData<InfiniteData<MessageListResponse>>(messageKey)
    expect(cacheData?.pages[0]?.items).toHaveLength(1)
  })

  // -- Empty channelId: no subscription --------------------------------------

  it('does not subscribe when channelId is empty', () => {
    const queryClient = createTestQueryClient()

    renderHook(() => useRealtimeMessages(''), {
      wrapper: createQueryWrapper(queryClient),
    })

    expect(supabase.channel).not.toHaveBeenCalled()
  })

  // -- Cleanup: removeChannel on unmount -------------------------------------

  it('calls supabase.removeChannel on unmount', () => {
    const queryClient = createTestQueryClient()
    const messageKey = queryKeys.messages.byChannel(CHANNEL_ID)
    queryClient.setQueryData(messageKey, buildCacheData([]))

    const { unmount } = renderHook(() => useRealtimeMessages(CHANNEL_ID), {
      wrapper: createQueryWrapper(queryClient),
    })

    expect(supabase.removeChannel).not.toHaveBeenCalled()

    unmount()

    expect(supabase.removeChannel).toHaveBeenCalledOnce()
    expect(supabase.removeChannel).toHaveBeenCalledWith(mockChannel.channel)
  })

  // -- No-op when cache is empty (undefined) ---------------------------------

  it('does not crash on INSERT when cache has no data', () => {
    const queryClient = createTestQueryClient()
    // Intentionally do NOT seed the cache

    renderHook(() => useRealtimeMessages(CHANNEL_ID), {
      wrapper: createQueryWrapper(queryClient),
    })

    // Should not throw
    fireInsert(mockChannel.handlers, buildRealtimeRow())

    const messageKey = queryKeys.messages.byChannel(CHANNEL_ID)
    const cacheData = queryClient.getQueryData<InfiniteData<MessageListResponse>>(messageKey)
    expect(cacheData).toBeUndefined()
  })
})
