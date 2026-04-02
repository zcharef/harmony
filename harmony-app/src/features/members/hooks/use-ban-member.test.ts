import { act, renderHook, waitFor } from '@testing-library/react'
import { queryKeys } from '@/lib/query-keys'
import { createQueryWrapper, createTestQueryClient } from '@/tests/test-utils'

vi.mock('@/lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/api')>()
  return { ...original, banMember: vi.fn() }
})

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}))

const { banMember } = await import('@/lib/api')
const { logger } = await import('@/lib/logger')
const { useBanMember } = await import('./use-ban-member')

const SERVER_ID = 'server-1'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useBanMember', () => {
  it('calls banMember SDK with correct path, body, and throwOnError', async () => {
    vi.mocked(banMember).mockResolvedValueOnce({ data: undefined } as never)

    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useBanMember(SERVER_ID), { wrapper })

    const banInput = { userId: 'user-to-ban', reason: 'spam' }

    await act(async () => {
      result.current.mutate(banInput)
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(banMember).toHaveBeenCalledOnce()
    expect(banMember).toHaveBeenCalledWith({
      path: { id: SERVER_ID },
      body: banInput,
      throwOnError: true,
    })
  })

  it('invalidates server members and bans queries on success', async () => {
    vi.mocked(banMember).mockResolvedValueOnce({ data: undefined } as never)

    const queryClient = createTestQueryClient()
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useBanMember(SERVER_ID), { wrapper })

    await act(async () => {
      result.current.mutate({ userId: 'user-1' })
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.servers.members(SERVER_ID),
    })
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.servers.bans(SERVER_ID),
    })
  })

  it('logs error via logger.error on rejection', async () => {
    vi.mocked(banMember).mockRejectedValueOnce(new Error('Connection refused'))

    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useBanMember(SERVER_ID), { wrapper })

    await act(async () => {
      result.current.mutate({ userId: 'user-1' })
    })

    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(logger.error).toHaveBeenCalledOnce()
    expect(logger.error).toHaveBeenCalledWith('Failed to ban member', {
      serverId: SERVER_ID,
      error: 'Connection refused',
    })
  })

  it('does not invalidate queries on failure', async () => {
    vi.mocked(banMember).mockRejectedValueOnce(new Error('fail'))

    const queryClient = createTestQueryClient()
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useBanMember(SERVER_ID), { wrapper })

    await act(async () => {
      result.current.mutate({ userId: 'user-1' })
    })

    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(invalidateSpy).not.toHaveBeenCalled()
  })
})
