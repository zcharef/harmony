import { act, renderHook, waitFor } from '@testing-library/react'
import { vi } from 'vitest'
import { queryKeys } from '@/lib/query-keys'
import { createQueryWrapper, createTestQueryClient } from '@/tests/test-utils'
import { useEditMessage } from './use-edit-message'

vi.mock('@/lib/api', () => ({
  editMessage: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

const { editMessage } = await import('@/lib/api')
const { logger } = await import('@/lib/logger')

const CHANNEL_ID = 'channel-1'

describe('useEditMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls editMessage with correct path, body, and throwOnError', async () => {
    const updatedMessage = {
      id: 'msg-1',
      channelId: CHANNEL_ID,
      authorId: 'user-1',
      authorUsername: 'alice',
      content: 'edited content',
      createdAt: '2026-03-16T00:00:00.000Z',
      editedAt: '2026-03-16T01:00:00.000Z',
    }
    vi.mocked(editMessage).mockResolvedValueOnce({ data: updatedMessage } as never)

    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)

    const { result } = renderHook(() => useEditMessage(CHANNEL_ID), { wrapper })

    await act(async () => {
      result.current.mutate({ messageId: 'msg-1', content: 'edited content' })
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(editMessage).toHaveBeenCalledOnce()
    expect(editMessage).toHaveBeenCalledWith({
      path: { channel_id: CHANNEL_ID, message_id: 'msg-1' },
      body: { content: 'edited content' },
      throwOnError: true,
    })
  })

  it('invalidates the message query on success', async () => {
    const updatedMessage = {
      id: 'msg-1',
      channelId: CHANNEL_ID,
      authorId: 'user-1',
      authorUsername: 'alice',
      content: 'edited',
      createdAt: '2026-03-16T00:00:00.000Z',
      editedAt: '2026-03-16T01:00:00.000Z',
    }
    vi.mocked(editMessage).mockResolvedValueOnce({ data: updatedMessage } as never)

    const queryClient = createTestQueryClient()
    const messageKey = queryKeys.messages.byChannel(CHANNEL_ID)
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useEditMessage(CHANNEL_ID), { wrapper })

    await act(async () => {
      result.current.mutate({ messageId: 'msg-1', content: 'edited' })
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: messageKey })
  })

  it('calls logger.error on mutation failure', async () => {
    vi.mocked(editMessage).mockRejectedValueOnce(new Error('Forbidden'))

    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)

    const { result } = renderHook(() => useEditMessage(CHANNEL_ID), { wrapper })

    await act(async () => {
      result.current.mutate({ messageId: 'msg-1', content: 'edited' })
    })

    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(logger.error).toHaveBeenCalledOnce()
    expect(logger.error).toHaveBeenCalledWith('Failed to edit message', {
      channelId: CHANNEL_ID,
      error: 'Forbidden',
    })
  })
})
