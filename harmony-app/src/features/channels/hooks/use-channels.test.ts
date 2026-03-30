import { waitFor } from '@testing-library/react'
import { vi } from 'vitest'
import { queryKeys } from '@/lib/query-keys'
import { renderHookWithQueryClient } from '@/tests/test-utils'
import { useChannels } from './use-channels'

vi.mock('@/lib/api', () => ({
  listChannels: vi.fn(),
}))

const { listChannels } = await import('@/lib/api')

const SERVER_ID = 'srv-chan-123'
const mockChannels = [
  { id: 'ch-1', name: 'general' },
  { id: 'ch-2', name: 'random' },
]

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useChannels', () => {
  it('returns data.items from listChannels response', async () => {
    vi.mocked(listChannels).mockResolvedValue({
      data: { items: mockChannels },
    } as never)

    const { result } = renderHookWithQueryClient(() => useChannels(SERVER_ID))

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })

    expect(result.current.data).toEqual(mockChannels)
  })

  it('calls listChannels with the correct path and throwOnError', async () => {
    vi.mocked(listChannels).mockResolvedValue({
      data: { items: [] },
    } as never)

    const { result } = renderHookWithQueryClient(() => useChannels(SERVER_ID))

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })

    expect(listChannels).toHaveBeenCalledWith({
      path: { id: SERVER_ID },
      throwOnError: true,
    })
  })

  it('uses the correct query key based on serverId', async () => {
    vi.mocked(listChannels).mockResolvedValue({
      data: { items: mockChannels },
    } as never)

    const { result, queryClient } = renderHookWithQueryClient(() => useChannels(SERVER_ID))

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })

    const cachedData = queryClient.getQueryData(queryKeys.channels.byServer(SERVER_ID))
    expect(cachedData).toEqual(mockChannels)
  })

  it('is disabled when serverId is null', () => {
    const { result } = renderHookWithQueryClient(() => useChannels(null))

    expect(result.current.fetchStatus).toBe('idle')
    expect(result.current.isPending).toBe(true)
    expect(listChannels).not.toHaveBeenCalled()
  })
})
