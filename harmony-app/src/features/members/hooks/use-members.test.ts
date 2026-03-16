import { vi } from 'vitest'
import { waitFor } from '@testing-library/react'
import { renderHookWithQueryClient } from '@/tests/test-utils'
import { queryKeys } from '@/lib/query-keys'
import { useMembers } from './use-members'

vi.mock('@/lib/api', () => ({
  listMembers: vi.fn(),
}))

const { listMembers } = await import('@/lib/api')

const SERVER_ID = 'srv-mem-456'
const mockMemberListResponse = {
  items: [
    { userId: 'usr-1', username: 'Alice', joinedAt: '2026-03-01T00:00:00Z' },
    { userId: 'usr-2', username: 'Bob', joinedAt: '2026-03-02T00:00:00Z' },
  ],
  total: 2,
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useMembers', () => {
  it('returns data from listMembers response', async () => {
    vi.mocked(listMembers).mockResolvedValue({
      data: mockMemberListResponse,
    } as never)

    const { result } = renderHookWithQueryClient(() => useMembers(SERVER_ID))

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })

    expect(result.current.data).toEqual(mockMemberListResponse)
    expect(result.current.data?.items).toHaveLength(2)
    expect(result.current.data?.items[0]?.userId).toBe('usr-1')
  })

  it('calls listMembers with the correct path and throwOnError', async () => {
    vi.mocked(listMembers).mockResolvedValue({
      data: mockMemberListResponse,
    } as never)

    const { result } = renderHookWithQueryClient(() => useMembers(SERVER_ID))

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })

    expect(listMembers).toHaveBeenCalledWith({
      path: { id: SERVER_ID },
      throwOnError: true,
    })
  })

  it('uses the correct query key based on serverId', async () => {
    vi.mocked(listMembers).mockResolvedValue({
      data: mockMemberListResponse,
    } as never)

    const { result, queryClient } = renderHookWithQueryClient(() => useMembers(SERVER_ID))

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })

    const cachedData = queryClient.getQueryData(queryKeys.servers.members(SERVER_ID))
    expect(cachedData).toEqual(mockMemberListResponse)
  })

  it('is disabled when serverId is null', () => {
    const { result } = renderHookWithQueryClient(() => useMembers(null))

    expect(result.current.fetchStatus).toBe('idle')
    expect(result.current.isPending).toBe(true)
    expect(listMembers).not.toHaveBeenCalled()
  })

  it('transitions to error state when listMembers rejects', async () => {
    vi.mocked(listMembers).mockRejectedValue(new Error('Unauthorized'))

    const { result } = renderHookWithQueryClient(() => useMembers(SERVER_ID))

    await waitFor(() => {
      expect(result.current.isError).toBe(true)
    })

    expect(result.current.error).toBeInstanceOf(Error)
    expect(result.current.error?.message).toBe('Unauthorized')
  })
})
