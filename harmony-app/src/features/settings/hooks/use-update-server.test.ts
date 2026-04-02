import { act, renderHook, waitFor } from '@testing-library/react'
import { queryKeys } from '@/lib/query-keys'
import { createQueryWrapper, createTestQueryClient } from '@/tests/test-utils'

vi.mock('@/lib/api', () => ({
  updateServer: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}))

const { updateServer } = await import('@/lib/api')
const { logger } = await import('@/lib/logger')
const { useUpdateServer } = await import('./use-update-server')

const SERVER_ID = 'server-1'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useUpdateServer', () => {
  it('calls updateServer with correct path, body, and throwOnError', async () => {
    const serverData = { name: 'New Name' }
    vi.mocked(updateServer).mockResolvedValueOnce({ data: serverData } as never)

    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useUpdateServer(SERVER_ID), { wrapper })

    await act(async () => {
      result.current.mutate({ name: 'New Name' })
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(updateServer).toHaveBeenCalledOnce()
    expect(updateServer).toHaveBeenCalledWith({
      path: { id: SERVER_ID },
      body: { name: 'New Name' },
      throwOnError: true,
    })
  })

  it('invalidates servers.all and servers.detail on success', async () => {
    vi.mocked(updateServer).mockResolvedValueOnce({ data: {} } as never)

    const queryClient = createTestQueryClient()
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useUpdateServer(SERVER_ID), { wrapper })

    await act(async () => {
      result.current.mutate({ name: 'Updated' })
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.servers.all,
    })
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.servers.detail(SERVER_ID),
    })
  })

  it('logs error via logger.error on failure', async () => {
    vi.mocked(updateServer).mockRejectedValueOnce(new Error('Validation failed'))

    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useUpdateServer(SERVER_ID), { wrapper })

    await act(async () => {
      result.current.mutate({ name: '' })
    })

    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(logger.error).toHaveBeenCalledOnce()
    expect(logger.error).toHaveBeenCalledWith('update_server_failed', {
      serverId: SERVER_ID,
      error: 'Validation failed',
    })
  })

  it('does not invalidate queries on failure', async () => {
    vi.mocked(updateServer).mockRejectedValueOnce(new Error('fail'))

    const queryClient = createTestQueryClient()
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useUpdateServer(SERVER_ID), { wrapper })

    await act(async () => {
      result.current.mutate({ name: '' })
    })

    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(invalidateSpy).not.toHaveBeenCalled()
  })
})
