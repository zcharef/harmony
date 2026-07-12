/**
 * Shared Cloudflare Pages Function handler for invite OG unfurl.
 *
 * Serves index.html with server-context OG tags injected so pasted invite
 * links unfurl as rich cards in Discord/Slack/iMessage/Twitter
 * (invite-landing ticket, decision #3).
 *
 * WHY shared: both the short `/i/:code` links we now build and the legacy
 * `/invite/:code` links must unfurl identically. This module is route-agnostic
 * — it keys off `params.code` and the request URL — so `functions/i/[code].ts`
 * and `functions/invite/[code].ts` are thin wrappers over `handleInviteOgRequest`.
 *
 * Design (deliberately dumb):
 *   - fetch the public preview from the API (3s budget)
 *   - template-inject OG tags into index.html
 *   - cache the result 60s (per-URL)
 *   - FAIL OPEN on anything unexpected: serve the untouched SPA shell.
 *
 * Requires the `HARMONY_API_URL` env var on the Pages project (e.g.
 * https://app.joinharmony.app). Missing var = fail-open, never an error page.
 */

import { buildInviteOgTags, injectIntoHead, isValidInviteCode, parseInviteOgPreview } from './og'

interface Env {
  HARMONY_API_URL?: string
  /**
   * Shared secret matching the API's TRUSTED_PROXY_SECRET. When set, the
   * original client IP is forwarded so the API's unauth rate limiter keys
   * on the real caller instead of this function's Cloudflare egress IP.
   */
  HARMONY_PROXY_SECRET?: string
  ASSETS: { fetch: (request: Request) => Promise<Response> }
}

interface PagesContext {
  request: Request
  env: Env
  params: Record<string, string | string[]>
  waitUntil: (promise: Promise<unknown>) => void
}

const OG_CACHE_NAME = 'invite-og'
const PREVIEW_TIMEOUT_MS = 3_000
const CACHE_TTL_SECONDS = 60
/** Absolute logo used when a server has no icon (served by this same Pages project). */
const FALLBACK_IMAGE_PATH = '/web-app-manifest-512x512.png'

export async function handleInviteOgRequest(context: PagesContext): Promise<Response> {
  const { request, env, params, waitUntil } = context

  // WHY open (not throw) on every early exit: this function must never make
  // an invite link LESS functional than the plain SPA.
  const serveSpaShell = () => env.ASSETS.fetch(new Request(new URL('/', request.url)))

  const rawCode = params.code
  const code = typeof rawCode === 'string' ? rawCode : ''
  if (!isValidInviteCode(code)) {
    return serveSpaShell()
  }

  const apiUrl = env.HARMONY_API_URL
  if (apiUrl === undefined || apiUrl.length === 0) {
    return serveSpaShell()
  }

  try {
    const cache = await caches.open(OG_CACHE_NAME)
    const cached = await cache.match(request)
    if (cached !== undefined) {
      return cached
    }

    const preview = await fetchInvitePreview(apiUrl, code, request, env.HARMONY_PROXY_SECRET)
    if (preview === null) {
      // Dead/unknown invite or API degraded — plain shell, no OG claims.
      return serveSpaShell()
    }

    const shellResponse = await serveSpaShell()
    const html = await shellResponse.text()

    const inviteUrl = new URL(request.url)
    const fallbackImage = new URL(FALLBACK_IMAGE_PATH, inviteUrl.origin).toString()
    const tags = buildInviteOgTags(
      preview,
      `${inviteUrl.origin}${inviteUrl.pathname}`,
      fallbackImage,
    )

    const response = new Response(injectIntoHead(html, tags), {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        // WHY 60s: crawlers hammer popular invites; member count staleness of
        // a minute is invisible while API load drops to ~1 req/min per code.
        'cache-control': `public, max-age=${CACHE_TTL_SECONDS}`,
      },
    })

    waitUntil(cache.put(request, response.clone()))
    return response
  } catch (error) {
    // WHY swallow-but-log: fail-open contract — the SPA renders the real
    // preview (or the invalid state) client-side. console.error is the
    // Workers-native log route (Cloudflare real-time logs / analytics);
    // the app's logger lib does not exist in this runtime.
    // biome-ignore lint/suspicious/noConsole: console is the only log sink in the Workers runtime — @/lib/logger targets the browser and does not exist here
    console.error(
      JSON.stringify({
        event: 'invite_og_fail_open',
        error: error instanceof Error ? error.message : String(error),
      }),
    )
    return serveSpaShell()
  }
}

/** Fetch the public invite preview; null on 404, non-200, timeout, or bad shape. */
async function fetchInvitePreview(
  apiUrl: string,
  code: string,
  request: Request,
  proxySecret: string | undefined,
): Promise<ReturnType<typeof parseInviteOgPreview>> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), PREVIEW_TIMEOUT_MS)

  // WHY forward the original client IP: this server-side fetch reaches the
  // API from Cloudflare egress, laundering the real caller — every crawler
  // and visitor would share one rate-limit bucket. The API trusts the
  // forwarded header only when the shared secret matches (see the API's
  // api::client_ip module). Both headers or neither — a bare IP header
  // without the secret is ignored by the API anyway.
  const clientIp = request.headers.get('cf-connecting-ip')
  const headers: Record<string, string> = { accept: 'application/json' }
  if (proxySecret !== undefined && proxySecret.length > 0 && clientIp !== null) {
    headers['x-harmony-proxy-secret'] = proxySecret
    headers['x-harmony-client-ip'] = clientIp
  }

  try {
    const response = await fetch(`${apiUrl.replace(/\/$/, '')}/v1/invites/${code}`, {
      signal: controller.signal,
      headers,
    })
    if (!response.ok) {
      return null
    }
    const body: unknown = await response.json()
    return parseInviteOgPreview(body)
  } finally {
    clearTimeout(timeout)
  }
}
