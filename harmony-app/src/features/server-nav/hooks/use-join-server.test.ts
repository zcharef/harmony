import { waitFor } from '@testing-library/react'
import { vi } from 'vitest'
import { queryKeys } from '@/lib/query-keys'
import { renderHookWithQueryClient } from '@/tests/test-utils'
import { useJoinServer } from './use-join-server'

vi.mock('@/lib/api', () => ({
  joinServer: vi.fn(),
}))

const { joinServer } = await import('@/lib/api')

const SERVER_ID = 'srv-join-789'
const INVITE_CODE = 'ABC123'
const mockJoinResponse = { id: SERVER_ID, name: 'Joined Server' }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useJoinServer', () => {
  it('calls joinServer with the correct path, body, and throwOnError', async () => {
    vi.mocked(joinServer).mockResolvedValue({
      data: mockJoinResponse,
    } as never)

    const { result } = renderHookWithQueryClient(() => useJoinServer())

    result.current.mutate({
      serverId: SERVER_ID,
      body: { invite_code: INVITE_CODE },
    } as never)

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })

    expect(joinServer).toHaveBeenCalledWith({
      path: { id: SERVER_ID },
      body: { invite_code: INVITE_CODE },
      throwOnError: true,
    })
  })

  it('returns data from joinServer response', async () => {
    vi.mocked(joinServer).mockResolvedValue({
      data: mockJoinResponse,
    } as never)

    const { result } = renderHookWithQueryClient(() => useJoinServer())

    result.current.mutate({
      serverId: SERVER_ID,
      body: { invite_code: INVITE_CODE },
    } as never)

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })

    expect(result.current.data).toEqual(mockJoinResponse)
  })

  it('passes serverId in the path parameter', async () => {
    vi.mocked(joinServer).mockResolvedValue({
      data: mockJoinResponse,
    } as never)

    const customServerId = 'srv-other-999'
    const { result } = renderHookWithQueryClient(() => useJoinServer())

    result.current.mutate({
      serverId: customServerId,
      body: { invite_code: 'XYZ' },
    } as never)

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })

    expect(joinServer).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { id: customServerId },
      }),
    )
  })

  it('invalidates servers.list cache on success', async () => {
    vi.mocked(joinServer).mockResolvedValue({
      data: mockJoinResponse,
    } as never)

    const { result, queryClient } = renderHookWithQueryClient(() => useJoinServer())

    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    result.current.mutate({
      serverId: SERVER_ID,
      body: { invite_code: INVITE_CODE },
    } as never)

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.servers.list(),
    })
  })

  it('transitions to error state when joinServer rejects', async () => {
    vi.mocked(joinServer).mockRejectedValue(new Error('Invalid invite'))

    const { result } = renderHookWithQueryClient(() => useJoinServer())

    result.current.mutate({
      serverId: SERVER_ID,
      body: { invite_code: 'EXPIRED' },
    } as never)

    await waitFor(() => {
      expect(result.current.isError).toBe(true)
    })

    expect(result.current.error).toBeInstanceOf(Error)
    expect(result.current.error?.message).toBe('Invalid invite')
  })
})
