import { act, renderHook, waitFor } from '@testing-library/react'
import { queryKeys } from '@/lib/query-keys'
import { createQueryWrapper, createTestQueryClient } from '@/tests/test-utils'

vi.mock('@/lib/api/client.gen', () => ({
  client: { patch: vi.fn() },
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}))

const { client } = await import('@/lib/api/client.gen')
const { logger } = await import('@/lib/logger')
const { useChangeRole } = await import('./use-change-role')

const SERVER_ID = 'server-1'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useChangeRole', () => {
  it('calls PATCH with correct URL, path, body, headers, and security', async () => {
    vi.mocked(client.patch).mockResolvedValueOnce({ error: undefined } as never)

    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useChangeRole(SERVER_ID), { wrapper })

    await act(async () => {
      result.current.mutate({ userId: 'user-1', role: 'moderator' })
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(client.patch).toHaveBeenCalledOnce()
    expect(client.patch).toHaveBeenCalledWith({
      url: '/v1/servers/{server_id}/members/{user_id}/role',
      path: { server_id: SERVER_ID, user_id: 'user-1' },
      body: { role: 'moderator' },
      headers: { 'Content-Type': 'application/json' },
      security: [{ scheme: 'bearer', type: 'http' }],
    })
  })

  it('invalidates server members query on success', async () => {
    vi.mocked(client.patch).mockResolvedValueOnce({ error: undefined } as never)

    const queryClient = createTestQueryClient()
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useChangeRole(SERVER_ID), { wrapper })

    await act(async () => {
      result.current.mutate({ userId: 'user-1', role: 'admin' })
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.servers.members(SERVER_ID),
    })
  })

  it('throws when API returns an error object', async () => {
    const apiError = { status: 403, detail: 'Insufficient permissions' }
    vi.mocked(client.patch).mockResolvedValueOnce({ error: apiError } as never)

    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useChangeRole(SERVER_ID), { wrapper })

    await act(async () => {
      result.current.mutate({ userId: 'user-1', role: 'admin' })
    })

    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(logger.error).toHaveBeenCalledWith(
      'Failed to change member role',
      expect.objectContaining({
        serverId: SERVER_ID,
      }),
    )
  })

  it('logs error via logger.error on rejection', async () => {
    vi.mocked(client.patch).mockRejectedValueOnce(new Error('Timeout'))

    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useChangeRole(SERVER_ID), { wrapper })

    await act(async () => {
      result.current.mutate({ userId: 'user-1', role: 'member' })
    })

    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(logger.error).toHaveBeenCalledOnce()
    expect(logger.error).toHaveBeenCalledWith('Failed to change member role', {
      serverId: SERVER_ID,
      error: 'Timeout',
    })
  })
})
