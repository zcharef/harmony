import { act, renderHook, waitFor } from '@testing-library/react'
import { queryKeys } from '@/lib/query-keys'
import { createTestQueryClient, createQueryWrapper } from '@/tests/test-utils'

vi.mock('@/lib/api/client.gen', () => ({
  client: { delete: vi.fn() },
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

const { client } = await import('@/lib/api/client.gen')
const { logger } = await import('@/lib/logger')
const { useKickMember } = await import('./use-kick-member')

const SERVER_ID = 'server-1'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useKickMember', () => {
  it('calls DELETE with correct URL, path params, and security', async () => {
    vi.mocked(client.delete).mockResolvedValueOnce({ error: undefined } as never)

    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useKickMember(SERVER_ID), { wrapper })

    await act(async () => {
      result.current.mutate('user-to-kick')
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(client.delete).toHaveBeenCalledOnce()
    expect(client.delete).toHaveBeenCalledWith({
      url: '/v1/servers/{server_id}/members/{user_id}',
      path: { server_id: SERVER_ID, user_id: 'user-to-kick' },
      security: [{ scheme: 'bearer', type: 'http' }],
    })
  })

  it('invalidates server members query on success', async () => {
    vi.mocked(client.delete).mockResolvedValueOnce({ error: undefined } as never)

    const queryClient = createTestQueryClient()
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useKickMember(SERVER_ID), { wrapper })

    await act(async () => {
      result.current.mutate('user-1')
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.servers.members(SERVER_ID),
    })
  })

  it('throws when API returns an error object', async () => {
    const apiError = { status: 403, detail: 'Forbidden' }
    vi.mocked(client.delete).mockResolvedValueOnce({ error: apiError } as never)

    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useKickMember(SERVER_ID), { wrapper })

    await act(async () => {
      result.current.mutate('user-1')
    })

    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(logger.error).toHaveBeenCalledWith('Failed to kick member', expect.objectContaining({
      serverId: SERVER_ID,
    }))
  })

  it('logs error via logger.error on rejection', async () => {
    vi.mocked(client.delete).mockRejectedValueOnce(new Error('Network error'))

    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useKickMember(SERVER_ID), { wrapper })

    await act(async () => {
      result.current.mutate('user-1')
    })

    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(logger.error).toHaveBeenCalledOnce()
    expect(logger.error).toHaveBeenCalledWith('Failed to kick member', {
      serverId: SERVER_ID,
      error: 'Network error',
    })
  })
})
