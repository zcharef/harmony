import { waitFor } from '@testing-library/react'
import { vi } from 'vitest'
import { queryKeys } from '@/lib/query-keys'
import { renderHookWithQueryClient } from '@/tests/test-utils'
import { useCreateDm } from './use-create-dm'

vi.mock('@/lib/api', () => ({
  createDm: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

const { createDm } = await import('@/lib/api')
const { logger } = await import('@/lib/logger')

const mockDmResponse = {
  serverId: 'srv-dm-1',
  channelId: 'ch-dm-1',
  recipient: {
    userId: 'user-2',
    username: 'alice',
    avatarUrl: null,
    status: 'online' as const,
  },
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useCreateDm', () => {
  it('calls createDm with correct body and throwOnError', async () => {
    vi.mocked(createDm).mockResolvedValueOnce({ data: mockDmResponse } as never)

    const { result } = renderHookWithQueryClient(() => useCreateDm())

    result.current.mutate('user-2')

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(createDm).toHaveBeenCalledOnce()
    expect(createDm).toHaveBeenCalledWith({
      body: { recipientId: 'user-2' },
      throwOnError: true,
    })
  })

  it('returns DM response data on success', async () => {
    vi.mocked(createDm).mockResolvedValueOnce({ data: mockDmResponse } as never)

    const { result } = renderHookWithQueryClient(() => useCreateDm())

    result.current.mutate('user-2')

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(result.current.data).toEqual(mockDmResponse)
  })

  it('invalidates dms.all and servers.all cache on success', async () => {
    vi.mocked(createDm).mockResolvedValueOnce({ data: mockDmResponse } as never)

    const { result, queryClient } = renderHookWithQueryClient(() => useCreateDm())

    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    result.current.mutate('user-2')

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.dms.all })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.servers.all })
  })

  it('calls logger.error on mutation failure', async () => {
    vi.mocked(createDm).mockRejectedValueOnce(new Error('Self-DM not allowed'))

    const { result } = renderHookWithQueryClient(() => useCreateDm())

    result.current.mutate('self-user-id')

    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(logger.error).toHaveBeenCalledOnce()
    expect(logger.error).toHaveBeenCalledWith('Failed to create DM', {
      error: 'Self-DM not allowed',
    })
  })

  it('transitions to error state when createDm rejects', async () => {
    vi.mocked(createDm).mockRejectedValueOnce(new Error('Conflict'))

    const { result } = renderHookWithQueryClient(() => useCreateDm())

    result.current.mutate('user-2')

    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(result.current.error).toBeInstanceOf(Error)
    expect(result.current.error?.message).toBe('Conflict')
  })
})
