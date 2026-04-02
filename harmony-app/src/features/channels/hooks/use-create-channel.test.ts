import { waitFor } from '@testing-library/react'
import { vi } from 'vitest'
import type { ChannelResponse } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { renderHookWithQueryClient } from '@/tests/test-utils'
import { useCreateChannel } from './use-create-channel'

vi.mock('@/lib/api', () => ({
  createChannel: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}))

const { createChannel } = await import('@/lib/api')
const { logger } = await import('@/lib/logger')

const SERVER_ID = 'srv-1'

const mockChannelResponse: ChannelResponse = {
  id: 'ch-new',
  serverId: SERVER_ID,
  name: 'new-channel',
  topic: null,
  channelType: 'text',
  position: 0,
  categoryId: null,
  isPrivate: false,
  isReadOnly: false,
  encrypted: false,
  createdAt: '2026-03-16T00:00:00.000Z',
  updatedAt: '2026-03-16T00:00:00.000Z',
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useCreateChannel', () => {
  it('calls createChannel with correct path, body, and throwOnError', async () => {
    vi.mocked(createChannel).mockResolvedValueOnce({ data: mockChannelResponse } as never)

    const { result } = renderHookWithQueryClient(() => useCreateChannel(SERVER_ID))

    result.current.mutate({ name: 'new-channel' } as never)

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(createChannel).toHaveBeenCalledOnce()
    expect(createChannel).toHaveBeenCalledWith({
      path: { id: SERVER_ID },
      body: { name: 'new-channel' },
      throwOnError: true,
    })
  })

  it('returns created channel data on success', async () => {
    vi.mocked(createChannel).mockResolvedValueOnce({ data: mockChannelResponse } as never)

    const { result } = renderHookWithQueryClient(() => useCreateChannel(SERVER_ID))

    result.current.mutate({ name: 'new-channel' } as never)

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(result.current.data).toEqual(mockChannelResponse)
  })

  it('invalidates channels.byServer cache on success', async () => {
    vi.mocked(createChannel).mockResolvedValueOnce({ data: mockChannelResponse } as never)

    const { result, queryClient } = renderHookWithQueryClient(() => useCreateChannel(SERVER_ID))

    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    result.current.mutate({ name: 'new-channel' } as never)

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.channels.byServer(SERVER_ID),
    })
  })

  it('calls logger.error when plan limit is exceeded', async () => {
    vi.mocked(createChannel).mockRejectedValueOnce(new Error('Channel limit reached'))

    const { result } = renderHookWithQueryClient(() => useCreateChannel(SERVER_ID))

    result.current.mutate({ name: 'over-limit' } as never)

    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(logger.error).toHaveBeenCalledOnce()
    expect(logger.error).toHaveBeenCalledWith('create_channel_failed', {
      error: 'Channel limit reached',
    })
  })
})
