import { waitFor } from '@testing-library/react'
import { vi } from 'vitest'
import { queryKeys } from '@/lib/query-keys'
import { renderHookWithQueryClient } from '@/tests/test-utils'
import { useDeleteChannel } from './use-delete-channel'

vi.mock('@/lib/api', () => ({
  deleteChannel: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}))

const { deleteChannel } = await import('@/lib/api')
const { logger } = await import('@/lib/logger')

const SERVER_ID = 'srv-1'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useDeleteChannel', () => {
  it('calls deleteChannel with correct path and throwOnError', async () => {
    vi.mocked(deleteChannel).mockResolvedValueOnce({ data: undefined } as never)

    const { result } = renderHookWithQueryClient(() => useDeleteChannel(SERVER_ID))

    result.current.mutate('ch-to-delete')

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(deleteChannel).toHaveBeenCalledOnce()
    expect(deleteChannel).toHaveBeenCalledWith({
      path: { id: SERVER_ID, channel_id: 'ch-to-delete' },
      throwOnError: true,
    })
  })

  it('invalidates channels.byServer cache on success', async () => {
    vi.mocked(deleteChannel).mockResolvedValueOnce({ data: undefined } as never)

    const { result, queryClient } = renderHookWithQueryClient(() => useDeleteChannel(SERVER_ID))

    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    result.current.mutate('ch-to-delete')

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.channels.byServer(SERVER_ID),
    })
  })

  it('calls logger.error when last channel deletion is rejected', async () => {
    vi.mocked(deleteChannel).mockRejectedValueOnce(
      new Error('Cannot delete the last channel in a server'),
    )

    const { result } = renderHookWithQueryClient(() => useDeleteChannel(SERVER_ID))

    result.current.mutate('ch-last')

    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(logger.error).toHaveBeenCalledOnce()
    expect(logger.error).toHaveBeenCalledWith('delete_channel_failed', {
      error: 'Cannot delete the last channel in a server',
    })
  })
})
