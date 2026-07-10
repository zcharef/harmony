import { useCallback } from 'react'
import { usePreferences, useUpdatePreferences } from '@/features/preferences'

/**
 * WHY: Thin selector composing the existing preferences hooks — no new query.
 *
 * showOnboarding gating rules (ticket §1.3):
 * - While preferences is undefined (cold cache OR failed GET), showOnboarding
 *   is false — the flow must never flash-then-disappear, and a returning user
 *   must never be trapped behind a failed preferences GET.
 * - Only an explicit server-persisted `onboardingCompleted === false` shows
 *   the flow.
 *
 * completeOnboarding is fire-and-forget optimistic: a failed PATCH rolls back
 * the cache (and logs) inside useUpdatePreferences — the user still proceeds
 * into the app this session and simply sees onboarding again on next load.
 */
export function useOnboarding() {
  const { data: preferences } = usePreferences()
  const updatePreferences = useUpdatePreferences()

  const showOnboarding = preferences !== undefined && preferences.onboardingCompleted === false

  const { mutate } = updatePreferences
  const completeOnboarding = useCallback(() => {
    mutate({ onboardingCompleted: true })
  }, [mutate])

  return { showOnboarding, completeOnboarding }
}
