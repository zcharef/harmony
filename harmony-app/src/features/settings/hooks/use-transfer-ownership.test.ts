import { act, renderHook, waitFor } from '@testing-library/react'
import { queryKeys } from '@/lib/query-keys'
import { createQueryWrapper, createTestQueryClient } from '@/tests/test-utils'

vi.mock('@/lib/api', () => ({
  transferOwnership: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

const { transferOwnership } = await import('@/lib/api')
const { logger } = await import('@/lib/logger')
const { useTransferOwnership } = await import('./use-transfer-ownership')

const SERVER_ID = 'server-1'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useTransferOwnership', () => {
  it('calls transferOwnership with correct path, body, and throwOnError', async () => {
    vi.mocked(transferOwnership).mockResolvedValueOnce({ data: undefined } as never)

    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useTransferOwnership(SERVER_ID), { wrapper })

    await act(async () => {
      result.current.mutate('new-owner-id')
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(transferOwnership).toHaveBeenCalledOnce()
    expect(transferOwnership).toHaveBeenCalledWith({
      path: { id: SERVER_ID },
      body: { newOwnerId: 'new-owner-id' },
      throwOnError: true,
    })
  })

  it('invalidates members, detail, and all queries on success', async () => {
    vi.mocked(transferOwnership).mockResolvedValueOnce({ data: undefined } as never)

    const queryClient = createTestQueryClient()
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useTransferOwnership(SERVER_ID), { wrapper })

    await act(async () => {
      result.current.mutate('new-owner-id')
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.servers.members(SERVER_ID),
    })
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.servers.detail(SERVER_ID),
    })
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.servers.all,
    })
  })

  it('logs error via logger.error on failure', async () => {
    vi.mocked(transferOwnership).mockRejectedValueOnce(new Error('Cannot transfer'))

    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useTransferOwnership(SERVER_ID), { wrapper })

    await act(async () => {
      result.current.mutate('new-owner-id')
    })

    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(logger.error).toHaveBeenCalledOnce()
    expect(logger.error).toHaveBeenCalledWith('Failed to transfer ownership', {
      serverId: SERVER_ID,
      error: 'Cannot transfer',
    })
  })

  it('does not invalidate queries on failure', async () => {
    vi.mocked(transferOwnership).mockRejectedValueOnce(new Error('fail'))

    const queryClient = createTestQueryClient()
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useTransferOwnership(SERVER_ID), { wrapper })

    await act(async () => {
      result.current.mutate('new-owner-id')
    })

    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(invalidateSpy).not.toHaveBeenCalled()
  })
})
