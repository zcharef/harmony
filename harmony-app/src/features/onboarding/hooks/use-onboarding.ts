import { useCallback, useState } from 'react'
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
 *
 * WHY completedThisSession latch: the optimistic rollback restores
 * `onboardingCompleted: false` in the cache when the PATCH fails (offline/5xx).
 * Without the latch, showOnboarding would flip back to true and yank the user
 * out of whatever they were viewing, back into the flow — contradicting §6.2
 * ("the user still proceeds into the app for this session"). The latch is
 * plain useState in a hook mounted by MainLayout (never unmounts), so a
 * rollback only re-shows onboarding on the next full load, as specified.
 */
export function useOnboarding() {
  const { data: preferences } = usePreferences()
  const updatePreferences = useUpdatePreferences()
  const [completedThisSession, setCompletedThisSession] = useState(false)

  const showOnboarding =
    !completedThisSession && preferences !== undefined && preferences.onboardingCompleted === false

  const { mutate } = updatePreferences
  const completeOnboarding = useCallback(() => {
    setCompletedThisSession(true)
    mutate({ onboardingCompleted: true })
  }, [mutate])

  return { showOnboarding, completeOnboarding }
}
