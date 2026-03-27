import { act, renderHook, waitFor } from '@testing-library/react'
import { queryKeys } from '@/lib/query-keys'
import { createTestQueryClient, createQueryWrapper } from '@/tests/test-utils'

vi.mock('@/lib/api', () => ({
  listBans: vi.fn(),
  unbanMember: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

const { listBans, unbanMember } = await import('@/lib/api')
const { logger } = await import('@/lib/logger')
const { useBans, useUnbanMember } = await import('./use-bans')

const SERVER_ID = 'server-1'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useBans', () => {
  it('fetches bans with correct path and throwOnError', async () => {
    const bansData = [
      { userId: 'user-1', username: 'banned-user', reason: 'spam' },
    ]
    vi.mocked(listBans).mockResolvedValueOnce({ data: bansData } as never)

    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)

    const { result } = renderHook(() => useBans(SERVER_ID), { wrapper })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(listBans).toHaveBeenCalledOnce()
    expect(listBans).toHaveBeenCalledWith({
      path: { id: SERVER_ID },
      throwOnError: true,
    })
    expect(result.current.data).toEqual(bansData)
  })

  it('uses the correct query key from factory', () => {
    vi.mocked(listBans).mockResolvedValueOnce({ data: [] } as never)

    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)

    renderHook(() => useBans(SERVER_ID), { wrapper })

    // Verify the query was registered with the correct key
    const queries = queryClient.getQueryCache().findAll({
      queryKey: queryKeys.servers.bans(SERVER_ID),
    })
    expect(queries).toHaveLength(1)
  })
})

describe('useUnbanMember', () => {
  it('calls unbanMember with correct path and throwOnError', async () => {
    vi.mocked(unbanMember).mockResolvedValueOnce({ data: undefined } as never)

    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useUnbanMember(SERVER_ID), { wrapper })

    await act(async () => {
      result.current.mutate('user-to-unban')
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(unbanMember).toHaveBeenCalledOnce()
    expect(unbanMember).toHaveBeenCalledWith({
      path: { id: SERVER_ID, user_id: 'user-to-unban' },
      throwOnError: true,
    })
  })

  it('invalidates bans and members queries on success', async () => {
    vi.mocked(unbanMember).mockResolvedValueOnce({ data: undefined } as never)

    const queryClient = createTestQueryClient()
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useUnbanMember(SERVER_ID), { wrapper })

    await act(async () => {
      result.current.mutate('user-1')
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.servers.bans(SERVER_ID),
    })
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.servers.members(SERVER_ID),
    })
  })

  it('logs error via logger.error on failure', async () => {
    vi.mocked(unbanMember).mockRejectedValueOnce(new Error('User not banned'))

    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useUnbanMember(SERVER_ID), { wrapper })

    await act(async () => {
      result.current.mutate('user-1')
    })

    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(logger.error).toHaveBeenCalledOnce()
    expect(logger.error).toHaveBeenCalledWith('Failed to unban member', {
      serverId: SERVER_ID,
      error: 'User not banned',
    })
  })

  it('does not invalidate queries on failure', async () => {
    vi.mocked(unbanMember).mockRejectedValueOnce(new Error('fail'))

    const queryClient = createTestQueryClient()
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useUnbanMember(SERVER_ID), { wrapper })

    await act(async () => {
      result.current.mutate('user-1')
    })

    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(invalidateSpy).not.toHaveBeenCalled()
  })
})
