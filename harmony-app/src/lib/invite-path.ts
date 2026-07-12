import { env } from '@/lib/env'
import { EXTERNAL_LINKS } from '@/lib/external-links'

/**
 * Invite URL parsing — SSoT for the invite path shape (ADR-033 companion to
 * routes.ts).
 *
 * WHY in lib (not features/invite): both the invite feature and the auth
 * feature (emailRedirectTo guard) need this, and invite already imports
 * LoginPage from auth — a feature-level home would create a circular
 * dependency. The app has no client-side router; App.tsx decides what to
 * render from window.location, and this module is the single place that
 * knows what a valid invite path looks like (mirrors the API's invite-code
 * format: 1-32 alphanumeric chars, see invite_service.rs).
 *
 * Two shapes are accepted: the short `/i/<code>` links we now build and share,
 * and the legacy `/invite/<code>` form kept for back-compat with links already
 * out in the wild.
 */

const INVITE_PATH_REGEX = /^\/(?:i|invite)\/([A-Za-z0-9]{1,32})\/?$/

/**
 * Normalizes user-entered invite text into the API invite code.
 *
 * WHY: people paste whole invite URLs into the manual join dialog. Treating
 * that as an invalid code adds friction at the exact activation moment.
 * Invalid URLs are returned unchanged so the existing form/API error path still
 * explains failures without inventing client-only validation rules.
 */
export function getInviteCodeFromInput(input: string): string {
  const trimmed = input.trim()
  try {
    const url = new URL(trimmed)
    return getInviteCodeFromPath(url.pathname) ?? trimmed
  } catch {
    return trimmed
  }
}

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

/**
 * Builds the shareable short invite URL for a code: `<base>/i/<code>`.
 *
 * WHY the `/i/` shape: a short, memorable link (joinharmony.app/i/XXXXX) that a
 * recipient opens to land straight on the join flow (App.tsx routes it via
 * getInviteCodeFromPath). The host is configurable per-deployment through
 * VITE_INVITE_BASE_URL, defaulting to the apex share domain.
 */
export function buildInviteUrl(code: string): string {
  const base = env.VITE_INVITE_BASE_URL ?? EXTERNAL_LINKS.INVITE_BASE
  return `${base.replace(/\/+$/, '')}/i/${code}`
}
