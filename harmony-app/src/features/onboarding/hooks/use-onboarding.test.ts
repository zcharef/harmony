import { act, renderHook, waitFor } from '@testing-library/react'
import { vi } from 'vitest'
import type { UserPreferencesResponse } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { createQueryWrapper, createTestQueryClient } from '@/tests/test-utils'
import { useOnboarding } from './use-onboarding'

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
const { logger } = await import('@/lib/logger')

function buildPreferences(
  overrides: Partial<UserPreferencesResponse> = {},
): UserPreferencesResponse {
  return {
    dndEnabled: false,
    hideProfanity: true,
    onboardingCompleted: false,
    notificationsEnabled: true,
    notifyMessages: true,
    notifyDms: true,
    notifyMentions: true,
    notificationSoundsEnabled: true,
    updatedAt: '2026-07-10T00:00:00.000Z',
    ...overrides,
  }
}

function renderOnboarding(inviteDeepLand = false) {
  const queryClient = createTestQueryClient()
  return renderHook(() => useOnboarding(inviteDeepLand), {
    wrapper: createQueryWrapper(queryClient),
  })
}

describe('useOnboarding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // WHY: The flow must never flash-then-disappear — while the preferences GET
  // is in flight the routing decision is "not first-run".
  it('showOnboarding is false while preferences is loading', () => {
    vi.mocked(getPreferences).mockReturnValue(new Promise(() => {}) as never)

    const { result } = renderOnboarding()

    expect(result.current.showOnboarding).toBe(false)
  })

  // WHY: A returning user must never be trapped behind a failed GET —
  // onboarding is a nice-to-have, the app is not (§1.3 error path).
  it('showOnboarding is false when the preferences GET fails', async () => {
    vi.mocked(getPreferences).mockRejectedValue(new Error('offline'))

    const { result } = renderOnboarding()

    await waitFor(() => expect(getPreferences).toHaveBeenCalled())
    expect(result.current.showOnboarding).toBe(false)
  })

  it('showOnboarding is true for a first-run user (onboardingCompleted false)', async () => {
    vi.mocked(getPreferences).mockResolvedValue({
      data: buildPreferences({ onboardingCompleted: false }),
    } as never)

    const { result } = renderOnboarding()

    await waitFor(() => expect(result.current.showOnboarding).toBe(true))
  })

  it('showOnboarding is false for a user who already completed onboarding', async () => {
    vi.mocked(getPreferences).mockResolvedValue({
      data: buildPreferences({ onboardingCompleted: true }),
    } as never)

    const { result } = renderOnboarding()

    // Wait for the query to settle, then assert the flow stays hidden.
    await waitFor(() => expect(getPreferences).toHaveBeenCalled())
    await waitFor(() => expect(result.current.showOnboarding).toBe(false))
  })

  // WHY: Completion is a single fire-and-forget PATCH — the entire write path
  // of the feature. Reactivity is optimistic-cache-driven: the same mutate
  // flips the cached flag, which flips showOnboarding without any refetch.
  it('completeOnboarding sends PATCH { onboardingCompleted: true } and hides the flow', async () => {
    vi.mocked(getPreferences).mockResolvedValue({
      data: buildPreferences({ onboardingCompleted: false }),
    } as never)
    vi.mocked(updatePreferences).mockResolvedValue({} as never)

    const { result } = renderOnboarding()
    await waitFor(() => expect(result.current.showOnboarding).toBe(true))

    await act(async () => {
      result.current.completeOnboarding()
    })

    expect(updatePreferences).toHaveBeenCalledWith({
      body: { onboardingCompleted: true },
      throwOnError: true,
    })
    // Optimistic cache write makes the gate flip immediately (no refetch).
    await waitFor(() => expect(result.current.showOnboarding).toBe(false))
  })

  // WHY: Regression for the rollback re-trap. A failed completion PATCH rolls
  // the optimistic cache back to onboardingCompleted: false — without the
  // completedThisSession latch, showOnboarding would flip back to true and
  // yank the user out of the app mid-session (§6.2 says they proceed for this
  // session and only see onboarding again on next load).
  it('showOnboarding stays false this session when the completion PATCH fails and rolls back', async () => {
    vi.mocked(getPreferences).mockResolvedValue({
      data: buildPreferences({ onboardingCompleted: false }),
    } as never)
    vi.mocked(updatePreferences).mockRejectedValue(new Error('offline'))

    const queryClient = createTestQueryClient()
    const { result } = renderHook(() => useOnboarding(), {
      wrapper: createQueryWrapper(queryClient),
    })
    await waitFor(() => expect(result.current.showOnboarding).toBe(true))

    await act(async () => {
      result.current.completeOnboarding()
    })

    // Wait for onError's rollback to restore onboardingCompleted: false in cache.
    await waitFor(() => {
      const cached = queryClient.getQueryData<UserPreferencesResponse>(queryKeys.preferences.me())
      expect(cached?.onboardingCompleted).toBe(false)
    })

    // The latch keeps the flow hidden despite the cache saying "not completed".
    expect(result.current.showOnboarding).toBe(false)
  })

  // WHY: Invite deep-land — a user who just joined a server through an invite
  // must land inside it, never in the generic tour. The tour's terminal goal
  // (get into a server) is already met, so it is also persisted as complete.
  it('invite deep-land suppresses the flow and persists completion for a first-run user', async () => {
    vi.mocked(getPreferences).mockResolvedValue({
      data: buildPreferences({ onboardingCompleted: false }),
    } as never)
    vi.mocked(updatePreferences).mockResolvedValue({} as never)

    const { result } = renderOnboarding(true)

    // Never shown, even after the preferences GET resolves to "first-run".
    await waitFor(() =>
      expect(updatePreferences).toHaveBeenCalledWith({
        body: { onboardingCompleted: true },
        throwOnError: true,
      }),
    )
    expect(result.current.showOnboarding).toBe(false)
  })

  // WHY: The deep-land PATCH is a background side-effect the user never
  // initiated — a transient failure (offline, 5xx) must not surface a
  // "preferences update failed" toast about a screen they have never seen
  // (ADR-045). User-clicked completion keeps its toast (covered in
  // use-update-preferences.test.ts).
  it('invite deep-land completion failure does not toast', async () => {
    vi.mocked(getPreferences).mockResolvedValue({
      data: buildPreferences({ onboardingCompleted: false }),
    } as never)
    vi.mocked(updatePreferences).mockRejectedValue(new Error('offline'))

    const { result } = renderOnboarding(true)

    // Wait until onError has actually run (it always logs), then assert
    // the toast branch was skipped and the flow stayed suppressed.
    await waitFor(() =>
      expect(logger.error).toHaveBeenCalledWith('update_preferences_failed', expect.anything()),
    )
    expect(toast.error).not.toHaveBeenCalled()
    expect(result.current.showOnboarding).toBe(false)
  })

  // WHY: A deep-land by a user who already finished onboarding must not
  // re-write the flag — the PATCH only fires for genuine first-runs.
  it('invite deep-land does not PATCH when onboarding is already completed', async () => {
    vi.mocked(getPreferences).mockResolvedValue({
      data: buildPreferences({ onboardingCompleted: true }),
    } as never)

    const { result } = renderOnboarding(true)

    await waitFor(() => expect(getPreferences).toHaveBeenCalled())
    expect(result.current.showOnboarding).toBe(false)
    expect(updatePreferences).not.toHaveBeenCalled()
  })
})
