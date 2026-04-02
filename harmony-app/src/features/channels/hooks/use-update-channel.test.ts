import { waitFor } from '@testing-library/react'
import { vi } from 'vitest'
import type { ChannelResponse } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { renderHookWithQueryClient } from '@/tests/test-utils'
import { useUpdateChannel } from './use-update-channel'

vi.mock('@/lib/api', () => ({
  updateChannel: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

const { updateChannel } = await import('@/lib/api')
const { logger } = await import('@/lib/logger')

const SERVER_ID = 'srv-1'
const CHANNEL_ID = 'ch-1'

const mockUpdatedChannel: ChannelResponse = {
  id: CHANNEL_ID,
  serverId: SERVER_ID,
  name: 'renamed-channel',
  topic: 'New topic',
  channelType: 'text',
  position: 0,
  categoryId: null,
  isPrivate: false,
  isReadOnly: false,
  encrypted: false,
  createdAt: '2026-03-16T00:00:00.000Z',
  updatedAt: '2026-03-16T01:00:00.000Z',
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useUpdateChannel', () => {
  it('calls updateChannel with correct path, body, and throwOnError', async () => {
    vi.mocked(updateChannel).mockResolvedValueOnce({ data: mockUpdatedChannel } as never)

    const { result } = renderHookWithQueryClient(() => useUpdateChannel(SERVER_ID, CHANNEL_ID))

    result.current.mutate({ name: 'renamed-channel', topic: 'New topic' } as never)

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(updateChannel).toHaveBeenCalledOnce()
    expect(updateChannel).toHaveBeenCalledWith({
      path: { id: SERVER_ID, channel_id: CHANNEL_ID },
      body: { name: 'renamed-channel', topic: 'New topic' },
      throwOnError: true,
    })
  })

  it('returns updated channel data on success', async () => {
    vi.mocked(updateChannel).mockResolvedValueOnce({ data: mockUpdatedChannel } as never)

    const { result } = renderHookWithQueryClient(() => useUpdateChannel(SERVER_ID, CHANNEL_ID))

    result.current.mutate({ name: 'renamed-channel' } as never)

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(result.current.data).toEqual(mockUpdatedChannel)
  })

  it('invalidates channels.byServer cache on success', async () => {
    vi.mocked(updateChannel).mockResolvedValueOnce({ data: mockUpdatedChannel } as never)

    const { result, queryClient } = renderHookWithQueryClient(() =>
      useUpdateChannel(SERVER_ID, CHANNEL_ID),
    )

    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    result.current.mutate({ name: 'renamed' } as never)

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.channels.byServer(SERVER_ID),
    })
  })

  it('calls logger.error when update validation fails', async () => {
    vi.mocked(updateChannel).mockRejectedValueOnce(new Error('Invalid channel name'))

    const { result } = renderHookWithQueryClient(() => useUpdateChannel(SERVER_ID, CHANNEL_ID))

    result.current.mutate({ name: 'INVALID NAME!' } as never)

    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(logger.error).toHaveBeenCalledOnce()
    expect(logger.error).toHaveBeenCalledWith('update_channel_failed', {
      error: 'Invalid channel name',
    })
  })
})
