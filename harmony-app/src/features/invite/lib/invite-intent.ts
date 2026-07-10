/**
 * Invite-accept intent, persisted across the auth round-trip.
 *
 * WHY: "Account creation AFTER intent" (invite-landing ticket) — the invitee
 * clicks "Accept invite" BEFORE having an account. The click is recorded
 * here; after signup/login completes, the landing page sees the recorded
 * intent and joins automatically instead of asking for a second click.
 *
 * sessionStorage (not localStorage): the intent is scoped to this tab's
 * flow — it must not leak into unrelated future sessions. Storage access is
 * wrapped because it throws in some private-browsing modes; degrading to
 * "one extra click" is acceptable there.
 */

const INTENT_KEY_PREFIX = 'harmony:invite-intent:'

export function recordInviteIntent(code: string): void {
  try {
    sessionStorage.setItem(`${INTENT_KEY_PREFIX}${code}`, '1')
  } catch {
    // Degrade silently: the user will click "Accept invite" once more.
  }
}

export function hasInviteIntent(code: string): boolean {
  try {
    return sessionStorage.getItem(`${INTENT_KEY_PREFIX}${code}`) === '1'
  } catch {
    return false
  }
}

export function clearInviteIntent(code: string): void {
  try {
    sessionStorage.removeItem(`${INTENT_KEY_PREFIX}${code}`)
  } catch {
    // Nothing to clean up if storage is unavailable.
  }
}
