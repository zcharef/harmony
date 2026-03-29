/**
 * Desktop auth flow — PKCE-based login via system browser + deep link.
 *
 * WHY: Cloudflare Turnstile doesn't work in Tauri's webview. Instead,
 * the desktop app opens the web login page in the system browser, which
 * redirects back via harmony:// deep link with a one-time auth code.
 * The code is exchanged for real tokens using PKCE (code_verifier/code_challenge)
 * to prevent scheme hijacking attacks.
 *
 * Flow:
 * 1. generatePKCE() → code_verifier (kept in memory) + code_challenge (sent to browser)
 * 2. openDesktopLogin() → opens browser with code_challenge + state nonce
 * 3. listenForAuthCallback() → catches deep link, validates state, redeems code
 * 4. redeemAuthCode() → exchanges code + code_verifier for tokens via Rust API
 */

import { env } from '@/lib/env'
import { logger } from '@/lib/logger'
import { openExternalUrl } from '@/lib/platform'

// ─── PKCE helpers ────────────────────────────────────────────────────

/** SHA-256 hash, base64url-encoded (S256 per RFC 7636). */
async function s256(plain: string): Promise<string> {
  const data = new TextEncoder().encode(plain)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

/** Generate a cryptographically random base64url string. */
function randomBase64Url(bytes: number): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return btoa(String.fromCharCode(...buf))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

export interface PKCEPair {
  codeVerifier: string
  codeChallenge: string
}

/** Generate a PKCE code_verifier + code_challenge (S256). */
export async function generatePKCE(): Promise<PKCEPair> {
  const codeVerifier = randomBase64Url(32)
  const codeChallenge = await s256(codeVerifier)
  return { codeVerifier, codeChallenge }
}

/** Generate a random state nonce for CSRF protection. */
export function generateState(): string {
  return randomBase64Url(16)
}

// ─── Browser + Deep Link ─────────────────────────────────────────────

/**
 * Open the web login page in the system browser with PKCE params.
 * Returns the state nonce and code_verifier needed to validate the callback.
 */
export async function openDesktopLogin(): Promise<{
  state: string
  codeVerifier: string
}> {
  const { codeVerifier, codeChallenge } = await generatePKCE()
  const state = generateState()

  // WHY: VITE_WEB_APP_URL is optional globally (web builds don't need it),
  // but required for desktop auth. Fail fast if misconfigured.
  const webAppUrl = env.VITE_WEB_APP_URL
  if (webAppUrl === undefined) {
    throw new Error('VITE_WEB_APP_URL is required for desktop auth. Check .env file.')
  }

  const url = new URL('/login', webAppUrl)
  url.searchParams.set('redirect_scheme', 'harmony')
  url.searchParams.set('code_challenge', codeChallenge)
  url.searchParams.set('state', state)

  await openExternalUrl(url.toString())

  return { state, codeVerifier }
}

/**
 * Listen for auth callback deep links.
 * Handles both warm (app already running) and cold start (app launched by deep link).
 *
 * Returns a cleanup function to unsubscribe the listener.
 */
export async function listenForAuthCallback(
  onCallback: (params: { code: string; state: string }) => void,
): Promise<() => void> {
  const { onOpenUrl, getCurrent } = await import('@tauri-apps/plugin-deep-link')

  function handleUrls(urls: string[]) {
    logger.info('desktop_auth_deep_link_received', { urls })
    for (const rawUrl of urls) {
      // WHY: `new URL('harmony://auth/callback')` parses differently across
      // browser engines — on older WebKitGTK (Linux) url.host is empty and
      // url.pathname is '//auth/callback'. String matching on the raw URL is
      // reliable everywhere.
      if (!rawUrl.startsWith('harmony://auth/callback')) continue

      try {
        // WHY: Replace custom scheme with https:// so URL parsing of query
        // params works reliably across all engines.
        const url = new URL(rawUrl.replace('harmony://', 'https://'))
        const code = url.searchParams.get('code')
        const state = url.searchParams.get('state')

        if (code !== null && state !== null) {
          onCallback({ code, state })
          return
        }

        logger.warn('desktop_auth_callback_missing_params', { url: rawUrl })
      } catch {
        logger.warn('desktop_auth_deep_link_parse_error', { url: rawUrl })
      }
    }

    // WHY: ADR-027 — no silent failures. If we reach here, none of the URLs
    // matched or contained valid params.
    logger.warn('desktop_auth_no_matching_callback', { urls })
  }

  // WHY: getCurrent() handles the cold-start case where the app was launched
  // BY the deep link itself (e.g., user force-quit the app while in the browser).
  const currentUrls = await getCurrent()
  if (currentUrls !== null && currentUrls.length > 0) {
    handleUrls(currentUrls)
  }

  logger.info('desktop_auth_registering_listener')
  const unlisten = await onOpenUrl(handleUrls)
  logger.info('desktop_auth_listener_registered')
  return unlisten
}

// ─── Token exchange ──────────────────────────────────────────────────

interface RedeemResult {
  accessToken: string
  refreshToken: string
}

/**
 * Exchange a one-time auth code + PKCE code_verifier for session tokens.
 * Calls the Rust API desktop-exchange/redeem endpoint (public, no auth needed).
 */
export async function redeemAuthCode(
  authCode: string,
  codeVerifier: string,
): Promise<RedeemResult> {
  const response = await fetch(`${env.VITE_API_URL}/v1/auth/desktop-exchange/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      auth_code: authCode,
      code_verifier: codeVerifier,
    }),
  })

  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    const detail =
      typeof body === 'object' && body !== null && 'detail' in body
        ? (body as { detail: string }).detail
        : 'Token exchange failed'
    throw new Error(detail)
  }

  const data: unknown = await response.json()
  if (
    typeof data !== 'object' ||
    data === null ||
    !('access_token' in data) ||
    typeof (data as Record<string, unknown>).access_token !== 'string' ||
    !('refresh_token' in data) ||
    typeof (data as Record<string, unknown>).refresh_token !== 'string'
  ) {
    throw new Error('Server returned incomplete token response')
  }
  const typed = data as { access_token: string; refresh_token: string }
  return { accessToken: typed.access_token, refreshToken: typed.refresh_token }
}
