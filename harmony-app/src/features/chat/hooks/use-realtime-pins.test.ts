import type { InfiniteData } from '@tanstack/react-query'
import { renderHook } from '@testing-library/react'
import { act } from 'react'
import { vi } from 'vitest'
import { SSE_EVENT_PREFIX } from '@/hooks/use-server-event'
import type { MessageListResponse, MessageResponse, PinnedMessagesResponse } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { createQueryWrapper, createTestQueryClient } from '@/tests/test-utils'
import { useRealtimePins } from './use-realtime-pins'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

const CHANNEL_ID = 'channel-1'

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
    mentions: [],
    attachments: [],
    isPinned: false,
    ...overrides,
  }
}

function buildMessagesCache(messages: MessageResponse[]): InfiniteData<MessageListResponse> {
  return { pages: [{ items: messages, nextCursor: null }], pageParams: [undefined] }
}

function fireSSEEvent(eventName: string, payload: unknown) {
  window.dispatchEvent(new CustomEvent(`${SSE_EVENT_PREFIX}${eventName}`, { detail: payload }))
}

function buildPinnedPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-1',
    channelId: CHANNEL_ID,
    content: 'pin me',
    authorId: 'user-42',
    authorUsername: 'alice',
    authorDisplayName: 'Alice Doe',
    authorAvatarUrl: null,
    encrypted: false,
    senderDeviceId: null,
    editedAt: null,
    messageType: 'default',
    isPinned: true,
    pinnedBy: 'user-7',
    pinnedAt: '2026-03-16T01:00:00.000Z',
    createdAt: '2026-03-16T00:00:00.000Z',
    ...overrides,
  }
}

describe('useRealtimePins', () => {
  beforeEach(() => vi.clearAllMocks())

  it('message.pinned prepends to the pins list AND flips isPinned in the message cache', () => {
    const queryClient = createTestQueryClient()
    const messagesKey = queryKeys.messages.byChannel(CHANNEL_ID)
    const pinsKey = queryKeys.pins.byChannel(CHANNEL_ID)
    queryClient.setQueryData(messagesKey, buildMessagesCache([buildMessage({ id: 'msg-1' })]))
    queryClient.setQueryData<PinnedMessagesResponse>(pinsKey, { items: [], total: 0 })

    renderHook(() => useRealtimePins(CHANNEL_ID), { wrapper: createQueryWrapper(queryClient) })

    act(() => {
      fireSSEEvent('message.pinned', {
        channelId: CHANNEL_ID,
        message: buildPinnedPayload({ id: 'msg-1' }),
      })
    })

    const pins = queryClient.getQueryData<PinnedMessagesResponse>(pinsKey)
    expect(pins?.items).toHaveLength(1)
    expect(pins?.items[0]?.id).toBe('msg-1')
    expect(pins?.total).toBe(1)

    const messages = queryClient.getQueryData<InfiniteData<MessageListResponse>>(messagesKey)
    expect(messages?.pages[0]?.items[0]?.isPinned).toBe(true)
  })

  it('message.pinned dedupes an already-present pin (optimistic + echo)', () => {
    const queryClient = createTestQueryClient()
    const pinsKey = queryKeys.pins.byChannel(CHANNEL_ID)
    queryClient.setQueryData<PinnedMessagesResponse>(pinsKey, {
      items: [buildMessage({ id: 'msg-1', isPinned: true })],
      total: 1,
    })

    renderHook(() => useRealtimePins(CHANNEL_ID), { wrapper: createQueryWrapper(queryClient) })

    act(() => {
      fireSSEEvent('message.pinned', {
        channelId: CHANNEL_ID,
        message: buildPinnedPayload({ id: 'msg-1' }),
      })
    })

    expect(queryClient.getQueryData<PinnedMessagesResponse>(pinsKey)?.items).toHaveLength(1)
  })

  it('message.unpinned removes from the pins list AND clears isPinned in the message cache', () => {
    const queryClient = createTestQueryClient()
    const messagesKey = queryKeys.messages.byChannel(CHANNEL_ID)
    const pinsKey = queryKeys.pins.byChannel(CHANNEL_ID)
    queryClient.setQueryData(
      messagesKey,
      buildMessagesCache([buildMessage({ id: 'msg-1', isPinned: true })]),
    )
    queryClient.setQueryData<PinnedMessagesResponse>(pinsKey, {
      items: [buildMessage({ id: 'msg-1', isPinned: true })],
      total: 1,
    })

    renderHook(() => useRealtimePins(CHANNEL_ID), { wrapper: createQueryWrapper(queryClient) })

    act(() => {
      fireSSEEvent('message.unpinned', { channelId: CHANNEL_ID, messageId: 'msg-1' })
    })

    expect(queryClient.getQueryData<PinnedMessagesResponse>(pinsKey)?.items).toHaveLength(0)
    const messages = queryClient.getQueryData<InfiniteData<MessageListResponse>>(messagesKey)
    expect(messages?.pages[0]?.items[0]?.isPinned).toBe(false)
  })

  it('message.deleted drops a pinned message from the pins list (no orphan pin)', () => {
    const queryClient = createTestQueryClient()
    const pinsKey = queryKeys.pins.byChannel(CHANNEL_ID)
    queryClient.setQueryData<PinnedMessagesResponse>(pinsKey, {
      items: [buildMessage({ id: 'msg-1', isPinned: true })],
      total: 1,
    })

    renderHook(() => useRealtimePins(CHANNEL_ID), { wrapper: createQueryWrapper(queryClient) })

    act(() => {
      fireSSEEvent('message.deleted', {
        channelId: CHANNEL_ID,
        messageId: 'msg-1',
        deletedBy: 'user-7',
      })
    })

    expect(queryClient.getQueryData<PinnedMessagesResponse>(pinsKey)?.items).toHaveLength(0)
  })
})
