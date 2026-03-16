import { vi } from 'vitest'
import { waitFor } from '@testing-library/react'
import { renderHookWithQueryClient } from '@/tests/test-utils'
import { queryKeys } from '@/lib/query-keys'
import { useCreateInvite } from './use-create-invite'

vi.mock('@/lib/api', () => ({
  createInvite: vi.fn(),
}))

const { createInvite } = await import('@/lib/api')

const SERVER_ID = 'srv-abc-123'
const mockInvite = { id: 'inv-1', code: 'XYZ123' }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useCreateInvite', () => {
  it('calls createInvite with the correct path, body, and throwOnError', async () => {
    vi.mocked(createInvite).mockResolvedValue({
      data: mockInvite,
    } as never)

    const { result } = renderHookWithQueryClient(() => useCreateInvite(SERVER_ID))

    result.current.mutate({ max_uses: 10 } as never)

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })

    expect(createInvite).toHaveBeenCalledWith({
      path: { id: SERVER_ID },
      body: { max_uses: 10 },
      throwOnError: true,
    })
  })

  it('returns data from createInvite response', async () => {
    vi.mocked(createInvite).mockResolvedValue({
      data: mockInvite,
    } as never)

    const { result } = renderHookWithQueryClient(() => useCreateInvite(SERVER_ID))

    result.current.mutate({ max_uses: 10 } as never)

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })

    expect(result.current.data).toEqual(mockInvite)
  })

  it('includes serverId in the path parameter', async () => {
    vi.mocked(createInvite).mockResolvedValue({
      data: mockInvite,
    } as never)

    const customServerId = 'srv-custom-456'
    const { result } = renderHookWithQueryClient(() => useCreateInvite(customServerId))

    result.current.mutate({} as never)

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })

    expect(createInvite).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { id: customServerId },
      }),
    )
  })

  it('invalidates servers.invites cache for the correct serverId on success', async () => {
    vi.mocked(createInvite).mockResolvedValue({
      data: mockInvite,
    } as never)

    const { result, queryClient } = renderHookWithQueryClient(() => useCreateInvite(SERVER_ID))

    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    result.current.mutate({} as never)

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.servers.invites(SERVER_ID),
    })
  })

  it('transitions to error state when createInvite rejects', async () => {
    vi.mocked(createInvite).mockRejectedValue(new Error('Forbidden'))

    const { result } = renderHookWithQueryClient(() => useCreateInvite(SERVER_ID))

    result.current.mutate({} as never)

    await waitFor(() => {
      expect(result.current.isError).toBe(true)
    })

    expect(result.current.error).toBeInstanceOf(Error)
    expect(result.current.error?.message).toBe('Forbidden')
  })
})
