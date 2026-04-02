import type { InfiniteData } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { vi } from 'vitest'
import type { MessageListResponse, MessageResponse } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { createQueryWrapper, createTestQueryClient } from '@/tests/test-utils'
import { useDeleteMessage } from './use-delete-message'

vi.mock('@/lib/api', () => ({
  deleteMessage: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

const { deleteMessage } = await import('@/lib/api')
const { logger } = await import('@/lib/logger')

const CHANNEL_ID = 'channel-1'
const CURRENT_USER_ID = 'user-99'

function buildMessage(overrides: Partial<MessageResponse> = {}): MessageResponse {
  return {
    id: 'msg-42',
    content: 'Hello',
    authorId: 'user-42',
    authorUsername: 'test-user',
    channelId: CHANNEL_ID,
    createdAt: '2026-01-01T00:00:00Z',
    editedAt: null,
    deletedBy: null,
    encrypted: false,
    senderDeviceId: null,
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

describe('useDeleteMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls deleteMessage with correct path and throwOnError', async () => {
    vi.mocked(deleteMessage).mockResolvedValueOnce({ data: undefined } as never)

    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)

    const { result } = renderHook(() => useDeleteMessage(CHANNEL_ID, CURRENT_USER_ID), { wrapper })

    await act(async () => {
      result.current.mutate('msg-42')
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(deleteMessage).toHaveBeenCalledOnce()
    expect(deleteMessage).toHaveBeenCalledWith({
      path: { channel_id: CHANNEL_ID, message_id: 'msg-42' },
      throwOnError: true,
    })
  })

  it('calls setQueryData with deletedBy updater on success', async () => {
    vi.mocked(deleteMessage).mockResolvedValueOnce({ data: undefined } as never)

    const queryClient = createTestQueryClient()
    const messageKey = queryKeys.messages.byChannel(CHANNEL_ID)
    const setDataSpy = vi.spyOn(queryClient, 'setQueryData')

    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useDeleteMessage(CHANNEL_ID, CURRENT_USER_ID), { wrapper })

    await act(async () => {
      result.current.mutate('msg-42')
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    // WHY: onSuccess calls setQueryData with a functional updater that sets
    // deletedBy on the matching message. We verify the updater produces the
    // correct result rather than checking the cache directly (gcTime: 0 in
    // test config GCs unobserved query data before the updater runs).
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
    const updated = updater?.(buildCacheData([buildMessage()]))
    expect(updated?.pages[0]?.items[0]?.deletedBy).toBe(CURRENT_USER_ID)
  })

  it('calls logger.error on mutation failure', async () => {
    vi.mocked(deleteMessage).mockRejectedValueOnce(new Error('Not Found'))

    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)

    const { result } = renderHook(() => useDeleteMessage(CHANNEL_ID, CURRENT_USER_ID), { wrapper })

    await act(async () => {
      result.current.mutate('msg-42')
    })

    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(logger.error).toHaveBeenCalledOnce()
    expect(logger.error).toHaveBeenCalledWith('Failed to delete message', {
      channelId: CHANNEL_ID,
      error: 'Not Found',
    })
  })
})
