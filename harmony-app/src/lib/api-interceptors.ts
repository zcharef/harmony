/**
 * Global API Interceptors — Level 1 of the Three-Level Error Architecture (ADR-045).
 *
 * WHY: This module registers response/error interceptors on the generated API client
 * (bundled by @hey-api/openapi-ts) to handle cross-cutting concerns that no individual hook should own:
 *   - x-request-id     → generated per-request for frontend↔backend log correlation
 *   - 401 Unauthorized → silent token refresh, then redirect to login on failure
 *   - 429 Rate Limited  → transparent retry respecting Retry-After header
 *   - All HTTP errors   → structured breadcrumb via logger (no PII)
 *
 * IMPORTANT: This is a side-effect module. Import it once at app startup (main.tsx).
 * It lives separately from api-client.ts to avoid the circular dependency
 * (api-client.ts is imported by the generated client.gen.ts, so it cannot
 * import from client.gen.ts itself).
 */

import { isAuthRetryableFetchError } from '@supabase/supabase-js'
import { client } from '@/lib/api/client.gen'
import { logger } from '@/lib/logger'
import { supabase } from '@/lib/supabase'

const REQUEST_ID_HEADER = 'x-request-id'

/**
 * Outcome of a token refresh attempt.
 * - `refreshed`: a new token was minted → retry the original request.
 * - `transient`: network drop / 5xx from the auth server → KEEP the session;
 *   let TanStack Query back off and supabase-js background auto-refresh recover.
 *   A flaky network at launch must never force a logout.
 * - `definitive`: the refresh token is genuinely dead (invalid_grant,
 *   refresh_token_not_found / already_used, expired session) → clear the session.
 */
type RefreshOutcome = 'refreshed' | 'transient' | 'definitive'

// WHY: Singleton promise prevents concurrent refresh races when multiple
// 401s arrive simultaneously (e.g., parallel queries on page load).
let refreshPromise: Promise<RefreshOutcome> | null = null

/** @internal Used by responseInterceptor below. */
async function refreshToken(): Promise<RefreshOutcome> {
  if (refreshPromise !== null) {
    return refreshPromise
  }

  refreshPromise = supabase.auth
    .refreshSession()
    .then(({ error }): RefreshOutcome => {
      if (error === null) {
        return 'refreshed'
      }
      // WHY library type (isAuthRetryableFetchError): only supabase-js's own
      // retryable class (network failure / 5xx) is transient. Anything else is
      // a definitive invalid-grant that should log out.
      return isAuthRetryableFetchError(error) ? 'transient' : 'definitive'
    })
    // WHY treat an unexpected throw as transient: a rejected promise here is an
    // infrastructure hiccup, not proof the refresh token is dead. Don't log out.
    .catch((): RefreshOutcome => 'transient')
    .finally(() => {
      refreshPromise = null
    })

  return refreshPromise
}

/** @internal Used by responseInterceptor for rate-limit retry. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** WHY: The @hey-api client passes the full resolved options object as the
 * third argument to response interceptors. After fetch() consumes the Request
 * body (bodyUsed = true), request.clone() and new Request(request) both throw
 * TypeError. We need `serializedBody` from opts to reconstruct the request. */
interface InterceptorOptions {
  fetch?: typeof globalThis.fetch
  serializedBody?: string
  body?: unknown
}

/**
 * Rebuild a Request from its still-readable metadata + the original body from opts.
 *
 * WHY not request.clone(): fetch() marks bodyUsed = true on the original Request.
 * Cloning a consumed Request throws TypeError. The request's url/method/headers
 * are still readable, and the body is preserved in opts.serializedBody by the
 * @hey-api client (set before fetch is called).
 */
function rebuildRequest(
  request: Request,
  opts: InterceptorOptions,
  headerOverrides?: Headers,
): Request {
  // WHY: opts.body is typed `unknown` to match the SDK's ResolvedRequestOptions.
  // serializedBody is always a string (preferred). body fallback is narrowed to
  // BodyInit | null | undefined — the only types the Request constructor accepts.
  const body =
    opts.serializedBody ??
    (opts.body instanceof Blob || typeof opts.body === 'string' ? opts.body : null)
  return new Request(request.url, {
    method: request.method,
    headers: headerOverrides ?? new Headers(request.headers),
    body,
  })
}

/**
 * Handle a 401 by refreshing the token and retrying, or (on a definitive
 * invalid-grant) clearing the session. Transient/network refresh failures
 * preserve the session and return the 401 for TanStack Query to back off on.
 *
 * WHY extracted: keeps `responseInterceptor` under the cognitive-complexity cap.
 */
async function handleUnauthorized(
  response: Response,
  request: Request,
  options: InterceptorOptions,
): Promise<Response> {
  const outcome = await refreshToken()

  if (outcome === 'definitive') {
    // WHY: Import auth store lazily to avoid import-order issues at startup.
    // Zustand stores are singletons — getState() works outside React components.
    const { useAuthStore } = await import('@/features/auth/stores/auth-store')
    useAuthStore.getState().clear()
    return response
  }

  if (outcome === 'transient') {
    // WHY keep the session: a network drop / 5xx at the auth server is
    // recoverable. Return the 401 so TanStack Query backs off and retries;
    // supabase-js's background auto-refresh recovers the token. Force-logging
    // out here (the old behavior) turned a launch-time network blip into a
    // forced re-login — the exact failure this hardening removes.
    return response
  }

  // WHY: Get a fresh token after successful refresh to build the retry request.
  const { data } = await supabase.auth.getSession()
  const newToken = data.session?.access_token
  if (newToken === undefined) {
    return response
  }

  const retryHeaders = new Headers(request.headers)
  retryHeaders.set('Authorization', `Bearer ${newToken}`)

  const _fetch = options.fetch ?? globalThis.fetch
  return _fetch(rebuildRequest(request, options, retryHeaders))
}

/**
 * Response interceptor — handles 401 and 429 transparently.
 *
 * WHY this is a response interceptor (not error):
 * In the generated API client, response interceptors run on every successful fetch
 * (before ok/error branching). This lets us retry the request and return a new
 * Response that the client processes normally — the caller never sees the 401/429.
 *
 * @internal Exported for testing only. The public API is the side-effect
 * registration at the bottom of this module.
 */
export async function responseInterceptor(
  response: Response,
  request: Request,
  options: InterceptorOptions,
): Promise<Response> {
  // --- Structured breadcrumb for ALL non-2xx responses ---
  // WHY: Include x-request-id so the breadcrumb can be correlated with backend
  // logs. The backend's SetRequestIdLayer uses the client-provided UUID (or
  // generates one if missing) and PropagateRequestIdLayer echoes it back.
  // WHY warn for 401/429: These have transparent retry paths — they are expected
  // rejections (ADR-046), not real errors. Using logger.error for them would
  // pollute the Sentry pre-crash trail with routine token refreshes (~1/hour).
  if (!response.ok) {
    const breadcrumb = {
      status: response.status,
      method: request.method,
      url: request.url,
      requestId: response.headers.get(REQUEST_ID_HEADER),
    }
    if (response.status === 401 || response.status === 429) {
      logger.warn('api_retry', breadcrumb)
    } else {
      logger.error('api_error', breadcrumb)
    }
  }

  // --- 401 Unauthorized: silent token refresh + retry ---
  if (response.status === 401) {
    return handleUnauthorized(response, request, options)
  }

  // --- 429 Rate Limited: transparent single retry ---
  if (response.status === 429) {
    const retryAfter = response.headers.get('Retry-After')
    // WHY: Retry-After is in seconds (RFC 9110 S10.2.3). Default to 1s if missing.
    const waitMs = retryAfter !== null ? Number.parseInt(retryAfter, 10) * 1000 : 1000

    await delay(waitMs)

    const _fetch = options.fetch ?? globalThis.fetch
    return _fetch(rebuildRequest(request, options))
  }

  return response
}

// --- Side-effect: register interceptors on the shared client instance ---

// WHY: Generate a UUID per request and attach it as x-request-id. The backend's
// SetRequestIdLayer respects client-provided IDs, so this single UUID appears in:
//   1. Frontend Sentry breadcrumbs (api_error above)
//   2. Backend structured logs (tracing spans via TraceLayer)
//   3. Backend Sentry transactions (tower SentryHttpLayer)
// To correlate: find the requestId in a Sentry breadcrumb → search backend logs.
client.interceptors.request.use((request) => {
  request.headers.set(REQUEST_ID_HEADER, crypto.randomUUID())
  return request
})

client.interceptors.response.use(responseInterceptor)
