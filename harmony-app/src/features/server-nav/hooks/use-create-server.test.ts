import { waitFor } from '@testing-library/react'
import { vi } from 'vitest'
import { queryKeys } from '@/lib/query-keys'
import { renderHookWithQueryClient } from '@/tests/test-utils'
import { useCreateServer } from './use-create-server'

vi.mock('@/lib/api', () => ({
  createServer: vi.fn(),
}))

const { createServer } = await import('@/lib/api')

const mockCreatedServer = { id: 'srv-new', name: 'New Server' }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useCreateServer', () => {
  it('calls createServer with the correct body and throwOnError', async () => {
    vi.mocked(createServer).mockResolvedValue({
      data: mockCreatedServer,
    } as never)

    const { result } = renderHookWithQueryClient(() => useCreateServer())

    result.current.mutate({ name: 'New Server' } as never)

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })

    expect(createServer).toHaveBeenCalledWith({
      body: { name: 'New Server' },
      throwOnError: true,
    })
  })

  it('returns data from createServer response', async () => {
    vi.mocked(createServer).mockResolvedValue({
      data: mockCreatedServer,
    } as never)

    const { result } = renderHookWithQueryClient(() => useCreateServer())

    result.current.mutate({ name: 'New Server' } as never)

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })

    expect(result.current.data).toEqual(mockCreatedServer)
  })

  it('invalidates servers.all cache on success', async () => {
    vi.mocked(createServer).mockResolvedValue({
      data: mockCreatedServer,
    } as never)

    const { result, queryClient } = renderHookWithQueryClient(() => useCreateServer())

    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    result.current.mutate({ name: 'New Server' } as never)

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.servers.all,
    })
  })
})
