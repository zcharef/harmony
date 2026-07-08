/**
 * WHY single resolver: The product identity chain `nickname ?? displayName ??
 * username` is a LOCKED decision (identity-polish plan). Encoding it in one
 * pure function keeps every render site consistent — no site may re-implement
 * the fallback order or forget a tier.
 *
 * Empty/whitespace-only values are treated as ABSENT so a blank display_name
 * (stored as "" rather than NULL) or a cleared nickname falls through to the
 * next tier instead of rendering an empty label.
 */
interface DisplayNameParts {
  /** Per-server nickname. Highest precedence. Absent for DM/profile/message shapes. */
  nickname?: string | null
  /** Account-wide display name. Absent for some cached shapes (e.g. ban rows). */
  displayName?: string | null
  /** Immutable username. Always present; the terminal fallback. */
  username: string
}

export function resolveDisplayName({ nickname, displayName, username }: DisplayNameParts): string {
  return firstNonBlank(nickname) ?? firstNonBlank(displayName) ?? username
}

/**
 * WHY: A tier counts as present only when it has non-whitespace content, and
 * the returned label is trimmed — a stored `" Alice "` (display names aren't
 * trimmed on save) must not render with stray padding. Usernames can't contain
 * whitespace, so trimming only ever affects display_name/nickname.
 */
function firstNonBlank(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}
