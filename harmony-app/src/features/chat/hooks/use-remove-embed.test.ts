import type { InfiniteData } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { vi } from 'vitest'
import type { MessageListResponse, MessageResponse } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { createQueryWrapper, createTestQueryClient } from '@/tests/test-utils'
import { useRemoveEmbed } from './use-remove-embed'

vi.mock('@/lib/api', () => ({
  removeMessageEmbed: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}))

const { removeMessageEmbed } = await import('@/lib/api')
const { logger } = await import('@/lib/logger')

const CHANNEL_ID = 'channel-1'

function buildMessage(overrides: Partial<MessageResponse> = {}): MessageResponse {
  return {
    id: 'msg-42',
    content: 'see https://example.com',
    authorId: 'user-42',
    authorUsername: 'test-user',
    channelId: CHANNEL_ID,
    createdAt: '2026-01-01T00:00:00Z',
    editedAt: null,
    deletedBy: null,
    encrypted: false,
    senderDeviceId: null,
    messageType: 'default',
    mentions: [],
    attachments: [],
    embeds: [
      { id: 'emb-1', url: 'https://example.com', title: 'Example' },
      { id: 'emb-2', url: 'https://other.example', title: 'Other' },
    ],
    isPinned: false,
    ...overrides,
  }
}

function buildCacheData(messages: MessageResponse[]): InfiniteData<MessageListResponse> {
  return {
    pages: [{ items: messages, nextCursor: null }],
    pageParams: [undefined],
  }
}

describe('useRemoveEmbed', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls removeMessageEmbed with the full path and throwOnError', async () => {
    vi.mocked(removeMessageEmbed).mockResolvedValueOnce({ data: undefined } as never)

    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useRemoveEmbed(CHANNEL_ID), { wrapper })

    await act(async () => {
      result.current.mutate({ messageId: 'msg-42', embedId: 'emb-1' })
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(removeMessageEmbed).toHaveBeenCalledOnce()
    expect(removeMessageEmbed).toHaveBeenCalledWith({
      path: { channel_id: CHANNEL_ID, message_id: 'msg-42', embed_id: 'emb-1' },
      throwOnError: true,
    })
  })

  it('patches the cache via setQueryData, removing ONLY the suppressed embed', async () => {
    vi.mocked(removeMessageEmbed).mockResolvedValueOnce({ data: undefined } as never)

    const queryClient = createTestQueryClient()
    const messageKey = queryKeys.messages.byChannel(CHANNEL_ID)
    const setDataSpy = vi.spyOn(queryClient, 'setQueryData')

    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useRemoveEmbed(CHANNEL_ID), { wrapper })

    await act(async () => {
      result.current.mutate({ messageId: 'msg-42', embedId: 'emb-1' })
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    // WHY verify through the functional updater (not the live cache): the test
    // query client GCs unobserved data instantly (gcTime: 0) — mirrors the
    // use-delete-message test approach.
    const mutationCall = setDataSpy.mock.calls.find(
      (call) =>
        JSON.stringify(call[0]) === JSON.stringify(messageKey) && typeof call[1] === 'function',
    )
    expect(mutationCall).toBeDefined()

    const updater = mutationCall?.[1] as
      | ((
          old: InfiniteData<MessageListResponse> | undefined,
        ) => InfiniteData<MessageListResponse> | undefined)
      | undefined
    const other = buildMessage({ id: 'msg-other' })
    const updated = updater?.(buildCacheData([buildMessage(), other]))

    const target = updated?.pages[0]?.items[0]
    expect(target?.embeds.map((e) => e.id)).toEqual(['emb-2'])
    // Untouched message keeps both embeds.
    expect(updated?.pages[0]?.items[1]?.embeds).toHaveLength(2)
  })

  it('logs and toasts on failure (explicit user action)', async () => {
    vi.mocked(removeMessageEmbed).mockRejectedValueOnce(new Error('Forbidden'))

    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useRemoveEmbed(CHANNEL_ID), { wrapper })

    await act(async () => {
      result.current.mutate({ messageId: 'msg-42', embedId: 'emb-1' })
    })

    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(logger.error).toHaveBeenCalledOnce()
    expect(logger.error).toHaveBeenCalledWith('Failed to remove link preview', {
      channelId: CHANNEL_ID,
      error: 'Forbidden',
    })
  })
})
