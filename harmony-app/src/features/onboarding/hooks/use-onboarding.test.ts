import { act, renderHook, waitFor } from '@testing-library/react'
import { vi } from 'vitest'
import type { UserPreferencesResponse } from '@/lib/api'
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

function buildPreferences(
  overrides: Partial<UserPreferencesResponse> = {},
): UserPreferencesResponse {
  return {
    dndEnabled: false,
    hideProfanity: true,
    onboardingCompleted: false,
    updatedAt: '2026-07-10T00:00:00.000Z',
    ...overrides,
  }
}

function renderOnboarding() {
  const queryClient = createTestQueryClient()
  return renderHook(() => useOnboarding(), { wrapper: createQueryWrapper(queryClient) })
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
})
