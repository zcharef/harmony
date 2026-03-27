import { act, renderHook, waitFor } from '@testing-library/react'
import { queryKeys } from '@/lib/query-keys'
import { createQueryWrapper, createTestQueryClient } from '@/tests/test-utils'

vi.mock('@/lib/api/client.gen', () => ({
  client: { delete: vi.fn() },
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

const { client } = await import('@/lib/api/client.gen')
const { logger } = await import('@/lib/logger')
const { useDeleteServer } = await import('./use-delete-server')

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useDeleteServer', () => {
  it('calls DELETE with correct URL, path, and security', async () => {
    vi.mocked(client.delete).mockResolvedValueOnce({ error: undefined } as never)

    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useDeleteServer(), { wrapper })

    await act(async () => {
      result.current.mutate('server-to-delete')
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(client.delete).toHaveBeenCalledOnce()
    expect(client.delete).toHaveBeenCalledWith({
      url: '/v1/servers/{id}',
      path: { id: 'server-to-delete' },
      security: [{ scheme: 'bearer', type: 'http' }],
    })
  })

  it('invalidates servers.all query on success', async () => {
    vi.mocked(client.delete).mockResolvedValueOnce({ error: undefined } as never)

    const queryClient = createTestQueryClient()
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useDeleteServer(), { wrapper })

    await act(async () => {
      result.current.mutate('server-1')
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.servers.all,
    })
  })

  it('throws when API returns an error object', async () => {
    const apiError = { status: 403, detail: 'Only the owner can delete' }
    vi.mocked(client.delete).mockResolvedValueOnce({ error: apiError } as never)

    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useDeleteServer(), { wrapper })

    await act(async () => {
      result.current.mutate('server-1')
    })

    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(logger.error).toHaveBeenCalledWith('Failed to delete server', expect.any(Object))
  })

  it('logs error via logger.error on rejection', async () => {
    vi.mocked(client.delete).mockRejectedValueOnce(new Error('Server not found'))

    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useDeleteServer(), { wrapper })

    await act(async () => {
      result.current.mutate('server-1')
    })

    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(logger.error).toHaveBeenCalledOnce()
    expect(logger.error).toHaveBeenCalledWith('Failed to delete server', {
      error: 'Server not found',
    })
  })
})
