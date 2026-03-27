import { waitFor } from '@testing-library/react'
import { vi } from 'vitest'
import { queryKeys } from '@/lib/query-keys'
import { renderHookWithQueryClient } from '@/tests/test-utils'
import { useCloseDm } from './use-close-dm'

vi.mock('@/lib/api', () => ({
  closeDm: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

const { closeDm } = await import('@/lib/api')
const { logger } = await import('@/lib/logger')

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useCloseDm', () => {
  it('calls closeDm with correct path and throwOnError', async () => {
    vi.mocked(closeDm).mockResolvedValueOnce({ data: undefined } as never)

    const { result } = renderHookWithQueryClient(() => useCloseDm())

    result.current.mutate('srv-dm-1')

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(closeDm).toHaveBeenCalledOnce()
    expect(closeDm).toHaveBeenCalledWith({
      path: { server_id: 'srv-dm-1' },
      throwOnError: true,
    })
  })

  it('invalidates dms.all and servers.all cache on success', async () => {
    vi.mocked(closeDm).mockResolvedValueOnce({ data: undefined } as never)

    const { result, queryClient } = renderHookWithQueryClient(() => useCloseDm())

    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    result.current.mutate('srv-dm-1')

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.dms.all })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.servers.all })
  })

  it('calls logger.error on mutation failure', async () => {
    vi.mocked(closeDm).mockRejectedValueOnce(new Error('Not found'))

    const { result } = renderHookWithQueryClient(() => useCloseDm())

    result.current.mutate('srv-nonexistent')

    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(logger.error).toHaveBeenCalledOnce()
    expect(logger.error).toHaveBeenCalledWith('Failed to close DM', {
      error: 'Not found',
    })
  })

  it('transitions to error state when closeDm rejects', async () => {
    vi.mocked(closeDm).mockRejectedValueOnce(new Error('Server error'))

    const { result } = renderHookWithQueryClient(() => useCloseDm())

    result.current.mutate('srv-dm-1')

    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(result.current.error).toBeInstanceOf(Error)
    expect(result.current.error?.message).toBe('Server error')
  })
})
