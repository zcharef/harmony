import { logger } from '@/lib/logger'

/**
 * harmony://invite/<code> deep links — desktop only.
 *
 * WHY strict parsing: the code charset mirrors the API's invite-code format
 * (1-32 alphanumeric, see invite-path.ts / invite_service.rs). Anything
 * else — query strings, extra path segments, other hosts — is rejected so a
 * crafted deep link can never navigate the app anywhere but /invite/:code.
 *
 * Pattern reference: desktop-auth.ts listenForAuthCallback (raw-URL string
 * matching, getCurrent() for cold start, onOpenUrl for warm start).
 */

const INVITE_DEEP_LINK_REGEX = /^harmony:\/\/invite\/([A-Za-z0-9]{1,32})\/?$/

/**
 * Extracts the invite code from a raw deep-link URL, or `null` when the URL
 * is not a well-formed invite deep link.
 */
export function parseInviteDeepLink(rawUrl: string): string | null {
  const match = INVITE_DEEP_LINK_REGEX.exec(rawUrl)
  if (match === null) return null
  return match[1] ?? null
}

/**
 * Listens for invite deep links — both warm (app running) and cold start
 * (app launched by the link). Non-invite URLs (e.g. auth callbacks) are
 * ignored; the auth listener owns those.
 *
 * Returns a cleanup function to unsubscribe the listener.
 */
export async function listenForInviteDeepLinks(
  onInvite: (code: string) => void,
): Promise<() => void> {
  const { onOpenUrl, getCurrent } = await import('@tauri-apps/plugin-deep-link')

  function handleUrls(urls: string[]) {
    for (const rawUrl of urls) {
      const code = parseInviteDeepLink(rawUrl)
      if (code !== null) {
        logger.info('invite_deep_link_received', {})
        onInvite(code)
        return
      }
    }
  }

  // WHY getCurrent(): cold-start case — the app was launched BY the invite
  // link itself, so the URL arrived before this listener existed.
  const currentUrls = await getCurrent()
  if (currentUrls !== null && currentUrls.length > 0) {
    handleUrls(currentUrls)
  }

  return onOpenUrl(handleUrls)
}
