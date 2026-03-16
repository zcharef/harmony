import { vi } from 'vitest'
import { waitFor } from '@testing-library/react'
import { renderHookWithQueryClient } from '@/tests/test-utils'
import { queryKeys } from '@/lib/query-keys'
import { useServers } from './use-servers'

vi.mock('@/lib/api', () => ({
  listServers: vi.fn(),
}))

const { listServers } = await import('@/lib/api')

const mockServers = [
  { id: 'srv-1', name: 'Alpha' },
  { id: 'srv-2', name: 'Bravo' },
]

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useServers', () => {
  it('returns data.items from listServers response', async () => {
    vi.mocked(listServers).mockResolvedValue({
      data: { items: mockServers },
    } as never)

    const { result } = renderHookWithQueryClient(() => useServers())

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })

    expect(result.current.data).toEqual(mockServers)
  })

  it('calls listServers with throwOnError: true', async () => {
    vi.mocked(listServers).mockResolvedValue({
      data: { items: [] },
    } as never)

    const { result } = renderHookWithQueryClient(() => useServers())

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })

    expect(listServers).toHaveBeenCalledWith({ throwOnError: true })
  })

  it('uses the correct query key', async () => {
    vi.mocked(listServers).mockResolvedValue({
      data: { items: mockServers },
    } as never)

    const { result, queryClient } = renderHookWithQueryClient(() => useServers())

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })

    const cachedData = queryClient.getQueryData(queryKeys.servers.list())
    expect(cachedData).toEqual(mockServers)
  })

  it('transitions to error state when listServers rejects', async () => {
    vi.mocked(listServers).mockRejectedValue(new Error('Network failure'))

    const { result } = renderHookWithQueryClient(() => useServers())

    await waitFor(() => {
      expect(result.current.isError).toBe(true)
    })

    expect(result.current.error).toBeInstanceOf(Error)
    expect(result.current.error?.message).toBe('Network failure')
  })
})
