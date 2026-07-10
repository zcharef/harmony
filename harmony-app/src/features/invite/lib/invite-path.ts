/**
 * Invite URL parsing — SSoT for the /invite/:code path shape.
 *
 * WHY: The app has no client-side router; App.tsx decides what to render
 * from window.location. This module is the single place that knows what a
 * valid invite path looks like (mirrors the API's invite-code format:
 * 1-32 alphanumeric chars, see invite_service.rs).
 */

const INVITE_PATH_REGEX = /^\/invite\/([A-Za-z0-9]{1,32})\/?$/

/**
 * Extracts the invite code from a pathname, or `null` when the path is not
 * an invite URL (including malformed codes — those fall through to the
 * normal app shell instead of an API call that can only 4xx).
 */
export function getInviteCodeFromPath(pathname: string): string | null {
  const match = INVITE_PATH_REGEX.exec(pathname)
  if (match === null) return null
  return match[1] ?? null
}
