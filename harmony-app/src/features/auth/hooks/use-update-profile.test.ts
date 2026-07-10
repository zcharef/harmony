import { QueryClient } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { vi } from 'vitest'
import type { ProfileResponse } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { createQueryWrapper, createTestQueryClient } from '@/tests/test-utils'
import { useUpdateProfile } from './use-update-profile'

vi.mock('@/lib/api', () => ({
  updateMyProfile: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

const { updateMyProfile } = await import('@/lib/api')
const { logger } = await import('@/lib/logger')

/**
 * WHY not createTestQueryClient: it sets gcTime: 0, and optimistic update
 * tests set cache data without an active query observer — gcTime: Infinity
 * keeps the data alive through the full mutation lifecycle (same pattern as
 * use-send-message.test.ts).
 */
function createMutationTestClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  })
}

function buildProfile(overrides: Partial<ProfileResponse> = {}): ProfileResponse {
  return {
    id: 'user-1',
    username: 'alice',
    displayName: 'Alice',
    avatarUrl: 'https://cdn.example/old.webp',
    status: 'online',
    customStatus: null,
    isFounding: false,
    createdAt: '2026-03-16T00:00:00.000Z',
    updatedAt: '2026-03-16T00:00:00.000Z',
    ...overrides,
  }
}

describe('useUpdateProfile', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls updateMyProfile with body and throwOnError', async () => {
    vi.mocked(updateMyProfile).mockResolvedValueOnce({
      data: buildProfile({ displayName: 'New Name' }),
    } as never)

    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useUpdateProfile(), { wrapper })

    await act(async () => {
      result.current.mutate({ displayName: 'New Name' })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(updateMyProfile).toHaveBeenCalledOnce()
    expect(updateMyProfile).toHaveBeenCalledWith({
      body: { displayName: 'New Name' },
      throwOnError: true,
    })
  })

  it('optimistically updates the cached profile, including explicit null clears', async () => {
    let resolveMutation: (value: unknown) => void = () => {}
    vi.mocked(updateMyProfile).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveMutation = resolve
        }) as never,
    )

    const queryClient = createMutationTestClient()
    const profileKey = queryKeys.profiles.me()
    queryClient.setQueryData(profileKey, buildProfile())

    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useUpdateProfile(), { wrapper })

    await act(async () => {
      result.current.mutate({ displayName: 'Renamed', avatarUrl: null })
    })

    await waitFor(() => {
      const cached = queryClient.getQueryData<ProfileResponse>(profileKey)
      expect(cached?.displayName).toBe('Renamed')
      // WHY: null must be applied (clears the avatar), not treated as "unchanged".
      expect(cached?.avatarUrl).toBeNull()
      // Untouched field is preserved.
      expect(cached?.username).toBe('alice')
    })

    resolveMutation({ data: buildProfile({ displayName: 'Renamed', avatarUrl: null }) })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
  })

  it('rolls back the cache and logs on failure', async () => {
    vi.mocked(updateMyProfile).mockRejectedValueOnce(new Error('Bad Request'))

    const queryClient = createMutationTestClient()
    const profileKey = queryKeys.profiles.me()
    const original = buildProfile()
    queryClient.setQueryData(profileKey, original)

    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useUpdateProfile(), { wrapper })

    await act(async () => {
      result.current.mutate({ displayName: 'Doomed' })
    })
    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(queryClient.getQueryData<ProfileResponse>(profileKey)).toEqual(original)
    expect(logger.error).toHaveBeenCalledWith('update_profile_failed', {
      error: 'Bad Request',
    })
  })

  it('invalidates the profile query on settle', async () => {
    vi.mocked(updateMyProfile).mockResolvedValueOnce({ data: buildProfile() } as never)

    const queryClient = createTestQueryClient()
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useUpdateProfile(), { wrapper })

    await act(async () => {
      result.current.mutate({ customStatus: 'brb' })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.profiles.me() })
  })
})
