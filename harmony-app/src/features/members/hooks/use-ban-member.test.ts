import { act, renderHook, waitFor } from '@testing-library/react'
import { queryKeys } from '@/lib/query-keys'
import { createQueryWrapper, createTestQueryClient } from '@/tests/test-utils'

vi.mock('@/lib/api/client.gen', () => ({
  client: { post: vi.fn() },
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}))

const { client } = await import('@/lib/api/client.gen')
const { logger } = await import('@/lib/logger')
const { useBanMember } = await import('./use-ban-member')

const SERVER_ID = 'server-1'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useBanMember', () => {
  it('calls POST with correct URL, path, body, headers, and security', async () => {
    vi.mocked(client.post).mockResolvedValueOnce({ error: undefined } as never)

    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useBanMember(SERVER_ID), { wrapper })

    const banInput = { userId: 'user-to-ban', reason: 'spam' }

    await act(async () => {
      result.current.mutate(banInput)
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(client.post).toHaveBeenCalledOnce()
    expect(client.post).toHaveBeenCalledWith({
      url: '/v1/servers/{server_id}/bans',
      path: { server_id: SERVER_ID },
      body: banInput,
      headers: { 'Content-Type': 'application/json' },
      security: [{ scheme: 'bearer', type: 'http' }],
    })
  })

  it('invalidates server members query on success', async () => {
    vi.mocked(client.post).mockResolvedValueOnce({ error: undefined } as never)

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
  })

  it('throws when API returns an error object', async () => {
    const apiError = { status: 403, detail: 'Not authorized' }
    vi.mocked(client.post).mockResolvedValueOnce({ error: apiError } as never)

    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useBanMember(SERVER_ID), { wrapper })

    await act(async () => {
      result.current.mutate({ userId: 'user-1' })
    })

    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(logger.error).toHaveBeenCalledWith(
      'Failed to ban member',
      expect.objectContaining({
        serverId: SERVER_ID,
      }),
    )
  })

  it('logs error via logger.error on rejection', async () => {
    vi.mocked(client.post).mockRejectedValueOnce(new Error('Connection refused'))

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
})
