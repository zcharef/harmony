/**
 * Global API Interceptors — Level 1 of the Three-Level Error Architecture (ADR-045).
 *
 * WHY: This module registers response/error interceptors on the generated API client
 * (bundled by @hey-api/openapi-ts) to handle cross-cutting concerns that no individual hook should own:
 *   - 401 Unauthorized → silent token refresh, then redirect to login on failure
 *   - 429 Rate Limited  → transparent retry respecting Retry-After header
 *   - All HTTP errors   → structured breadcrumb via logger (no PII)
 *
 * IMPORTANT: This is a side-effect module. Import it once at app startup (main.tsx).
 * It lives separately from api-client.ts to avoid the circular dependency
 * (api-client.ts is imported by the generated client.gen.ts, so it cannot
 * import from client.gen.ts itself).
 */

import { client } from '@/lib/api/client.gen'
import { logger } from '@/lib/logger'
import { supabase } from '@/lib/supabase'

// WHY: Singleton promise prevents concurrent refresh races when multiple
// 401s arrive simultaneously (e.g., parallel queries on page load).
let refreshPromise: Promise<boolean> | null = null

/** @internal Used by responseInterceptor below. */
async function refreshToken(): Promise<boolean> {
  if (refreshPromise !== null) {
    return refreshPromise
  }

  refreshPromise = supabase.auth
    .refreshSession()
    .then(({ error }) => error === null)
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
  if (!response.ok) {
    logger.error('api_error', {
      status: response.status,
      method: request.method,
      url: request.url,
    })
  }

  // --- 401 Unauthorized: silent token refresh + retry ---
  if (response.status === 401) {
    const refreshed = await refreshToken()

    if (!refreshed) {
      // WHY: Import auth store lazily to avoid import-order issues at startup.
      // Zustand stores are singletons — getState() works outside React components.
      const { useAuthStore } = await import('@/features/auth/stores/auth-store')
      useAuthStore.getState().clear()
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

// --- Side-effect: register the interceptor on the shared client instance ---
client.interceptors.response.use(responseInterceptor)
