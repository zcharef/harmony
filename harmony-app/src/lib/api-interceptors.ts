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

/** @internal Exported for testing only. */
export async function refreshToken(): Promise<boolean> {
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

/** @internal Exported for testing only. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
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
  options: { fetch?: typeof globalThis.fetch },
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

    // WHY: Request headers are immutable after construction, so we clone with
    // the updated Authorization header for the retry.
    const retryHeaders = new Headers(request.headers)
    retryHeaders.set('Authorization', `Bearer ${newToken}`)
    const retryRequest = new Request(request, { headers: retryHeaders })

    const _fetch = options.fetch ?? globalThis.fetch
    return _fetch(retryRequest)
  }

  // --- 429 Rate Limited: transparent single retry ---
  if (response.status === 429) {
    const retryAfter = response.headers.get('Retry-After')
    // WHY: Retry-After is in seconds (RFC 9110 S10.2.3). Default to 1s if missing.
    const waitMs = retryAfter !== null ? Number.parseInt(retryAfter, 10) * 1000 : 1000

    await delay(waitMs)

    const _fetch = options.fetch ?? globalThis.fetch
    return _fetch(request.clone())
  }

  return response
}

// --- Side-effect: register the interceptor on the shared client instance ---
client.interceptors.response.use(responseInterceptor)
