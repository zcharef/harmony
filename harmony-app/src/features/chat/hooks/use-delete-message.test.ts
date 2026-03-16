import { vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
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

describe('useDeleteMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls deleteMessage with correct path and throwOnError', async () => {
    vi.mocked(deleteMessage).mockResolvedValueOnce({ data: undefined } as never)

    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)

    const { result } = renderHook(() => useDeleteMessage(CHANNEL_ID), { wrapper })

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

  it('invalidates the message query on success', async () => {
    vi.mocked(deleteMessage).mockResolvedValueOnce({ data: undefined } as never)

    const queryClient = createTestQueryClient()
    const messageKey = queryKeys.messages.byChannel(CHANNEL_ID)
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useDeleteMessage(CHANNEL_ID), { wrapper })

    await act(async () => {
      result.current.mutate('msg-42')
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: messageKey })
  })

  it('calls logger.error on mutation failure', async () => {
    vi.mocked(deleteMessage).mockRejectedValueOnce(new Error('Not Found'))

    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)

    const { result } = renderHook(() => useDeleteMessage(CHANNEL_ID), { wrapper })

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
