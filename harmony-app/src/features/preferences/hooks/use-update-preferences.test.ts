import { act, renderHook, waitFor } from '@testing-library/react'
import { vi } from 'vitest'
import type { UserPreferencesResponse } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { createQueryWrapper, createTestQueryClient } from '@/tests/test-utils'
import { usePreferences } from './use-preferences'
import { useUpdatePreferences } from './use-update-preferences'

vi.mock('@/lib/api', () => ({
  getPreferences: vi.fn(),
  updatePreferences: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}))

vi.mock('i18next', () => ({
  default: { t: vi.fn((key: string) => key) },
}))

const { getPreferences, updatePreferences } = await import('@/lib/api')
const { toast } = await import('@/lib/toast')

function buildPreferences(
  overrides: Partial<UserPreferencesResponse> = {},
): UserPreferencesResponse {
  return {
    dndEnabled: false,
    hideProfanity: true,
    updatedAt: '2026-04-02T00:00:00.000Z',
    ...overrides,
  }
}

/**
 * Mounts the mutation together with a live usePreferences observer.
 *
 * WHY: createTestQueryClient uses gcTime 0 — unobserved cache entries are
 * garbage-collected between awaits. The observer keeps the preferences entry
 * alive AND asserts what a real consumer (DND hooks, StatusPicker) would see.
 */
function renderPreferencesHooks(seed?: UserPreferencesResponse) {
  const queryClient = createTestQueryClient()
  if (seed !== undefined) {
    queryClient.setQueryData(queryKeys.preferences.me(), seed)
  }

  const rendered = renderHook(
    () => ({ update: useUpdatePreferences(), preferences: usePreferences() }),
    { wrapper: createQueryWrapper(queryClient) },
  )

  return { queryClient, ...rendered }
}

describe('useUpdatePreferences', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // WHY: The observer's background refetch must never resolve — the seeded
    // cache and the mutation's writes stay authoritative in each scenario.
    vi.mocked(getPreferences).mockReturnValue(new Promise(() => {}) as never)
  })

  it('sends PATCH /v1/preferences with the patch body and throwOnError', async () => {
    vi.mocked(updatePreferences).mockResolvedValueOnce({} as never)

    const { result } = renderPreferencesHooks(buildPreferences())

    await act(async () => {
      result.current.update.mutate({ dndEnabled: true })
    })
    await waitFor(() => expect(result.current.update.isSuccess).toBe(true))

    expect(updatePreferences).toHaveBeenCalledOnce()
    expect(updatePreferences).toHaveBeenCalledWith({
      body: { dndEnabled: true },
      throwOnError: true,
    })
  })

  it('optimistically flips the cache before the request resolves', async () => {
    // WHY never-resolving promise: freezes the mutation in-flight so the
    // assertion observes the optimistic state, not the settled state.
    vi.mocked(updatePreferences).mockReturnValueOnce(new Promise(() => {}) as never)

    const { result } = renderPreferencesHooks(buildPreferences({ dndEnabled: false }))

    await act(async () => {
      result.current.update.mutate({ dndEnabled: true })
    })

    // WHY waitFor: TanStack Query v5 notifies observers via a setTimeout(0)
    // macrotask — the observer needs one tick to see the optimistic write.
    await waitFor(() => expect(result.current.preferences.data?.dndEnabled).toBe(true))
  })

  it('preserves untouched fields on a partial patch', async () => {
    vi.mocked(updatePreferences).mockReturnValueOnce(new Promise(() => {}) as never)

    const { result } = renderPreferencesHooks(
      buildPreferences({ dndEnabled: true, hideProfanity: true }),
    )

    await act(async () => {
      result.current.update.mutate({ hideProfanity: false })
    })

    await waitFor(() => expect(result.current.preferences.data?.hideProfanity).toBe(false))
    expect(result.current.preferences.data?.dndEnabled).toBe(true)
  })

  it('rolls back to the previous cache value on error and toasts', async () => {
    vi.mocked(updatePreferences).mockRejectedValueOnce(new Error('boom'))

    const { result } = renderPreferencesHooks(buildPreferences({ dndEnabled: false }))

    await act(async () => {
      result.current.update.mutate({ dndEnabled: true })
    })
    await waitFor(() => expect(result.current.update.isError).toBe(true))

    await waitFor(() => expect(result.current.preferences.data?.dndEnabled).toBe(false))
    expect(toast.error).toHaveBeenCalledOnce()
  })

  it('rolls back to server defaults on error when no previous cache exists', async () => {
    vi.mocked(updatePreferences).mockRejectedValueOnce(new Error('boom'))

    // Intentionally no seed: first-ever toggle before GET resolves.
    const { result } = renderPreferencesHooks()

    await act(async () => {
      result.current.update.mutate({ dndEnabled: true })
    })
    await waitFor(() => expect(result.current.update.isError).toBe(true))

    await waitFor(() => expect(result.current.preferences.data?.dndEnabled).toBe(false))
    expect(result.current.preferences.data?.hideProfanity).toBe(true)
  })
})
