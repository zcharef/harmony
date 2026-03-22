import { AuthError } from '@supabase/supabase-js'
import { vi } from 'vitest'

// -- Module mocks (hoisted before imports) ------------------------------------

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      refreshSession: vi.fn(),
      getSession: vi.fn(),
    },
  },
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

vi.mock('@/features/auth/stores/auth-store', () => {
  const clear = vi.fn()
  return {
    useAuthStore: { getState: () => ({ clear }) },
  }
})

// WHY: The production module has a side-effect that calls
// `client.interceptors.response.use()` on import. We mock the client to
// prevent that side-effect and test the exported handler directly.
vi.mock('@/lib/api/client.gen', () => ({
  client: {
    interceptors: {
      response: { use: vi.fn() },
    },
  },
}))

// -- Imports (after mocks) ----------------------------------------------------

const { supabase } = await import('@/lib/supabase')
const { logger } = await import('@/lib/logger')
const { useAuthStore } = await import('@/features/auth/stores/auth-store')
const { responseInterceptor } = await import('@/lib/api-interceptors')

// -- Helpers ------------------------------------------------------------------

function buildRequest(overrides: RequestInit & { url?: string } = {}): Request {
  const { url = 'http://localhost:3000/v1/messages', ...init } = overrides
  return new Request(url, { method: 'GET', ...init })
}

function buildResponse(status: number, headers?: Record<string, string>): Response {
  return new Response(null, { status, headers })
}

function buildOptions(fetchFn?: typeof globalThis.fetch) {
  return { fetch: fetchFn }
}

// -- Tests --------------------------------------------------------------------

describe('responseInterceptor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  // -- Breadcrumb logging for all non-2xx responses ---------------------------

  describe('breadcrumb logging', () => {
    it('logs api_error breadcrumb for non-2xx responses', async () => {
      const request = buildRequest({ method: 'POST' })
      const response = buildResponse(500)

      const result = await responseInterceptor(response, request, buildOptions())

      expect(logger.error).toHaveBeenCalledOnce()
      expect(logger.error).toHaveBeenCalledWith('api_error', {
        status: 500,
        method: 'POST',
        url: 'http://localhost:3000/v1/messages',
      })
      // WHY: 5xx responses propagate as-is (no retry at the interceptor level).
      expect(result).toBe(response)
    })

    it('does not log for 2xx responses', async () => {
      const request = buildRequest()
      const response = buildResponse(200)

      const result = await responseInterceptor(response, request, buildOptions())

      expect(logger.error).not.toHaveBeenCalled()
      expect(result).toBe(response)
    })

    it('logs for 4xx responses other than 401/429', async () => {
      const request = buildRequest()
      const response = buildResponse(403)

      const result = await responseInterceptor(response, request, buildOptions())

      expect(logger.error).toHaveBeenCalledOnce()
      expect(logger.error).toHaveBeenCalledWith('api_error', {
        status: 403,
        method: 'GET',
        url: 'http://localhost:3000/v1/messages',
      })
      // WHY: 403 is neither 401 nor 429 — response passes through untouched.
      expect(result).toBe(response)
    })
  })

  // -- 401: token refresh + retry ---------------------------------------------

  describe('401 — token refresh + retry', () => {
    it('refreshes token and retries request with new Authorization header', async () => {
      const retryResponse = buildResponse(200)
      const mockFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(retryResponse)

      vi.mocked(supabase.auth.refreshSession).mockResolvedValue({
        data: { session: null, user: null },
        error: null,
      })
      vi.mocked(supabase.auth.getSession).mockResolvedValue({
        data: { session: { access_token: 'fresh-token' } as never },
        error: null,
      })

      const request = buildRequest({
        headers: { Authorization: 'Bearer stale-token' },
      })
      const response = buildResponse(401)

      const result = await responseInterceptor(response, request, buildOptions(mockFetch))

      expect(supabase.auth.refreshSession).toHaveBeenCalledOnce()
      expect(supabase.auth.getSession).toHaveBeenCalledOnce()
      expect(mockFetch).toHaveBeenCalledOnce()

      // Verify the retried request has the new token
      const retriedRequest = mockFetch.mock.calls[0]![0] as Request
      expect(retriedRequest.headers.get('Authorization')).toBe('Bearer fresh-token')

      expect(result).toBe(retryResponse)
    })

    it('clears auth store when refresh fails', async () => {
      vi.mocked(supabase.auth.refreshSession).mockResolvedValue({
        data: { session: null, user: null },
        error: new AuthError('expired', 401, 'session_expired'),
      })

      const request = buildRequest()
      const response = buildResponse(401)

      const result = await responseInterceptor(response, request, buildOptions())

      expect(supabase.auth.refreshSession).toHaveBeenCalledOnce()
      expect(useAuthStore.getState().clear).toHaveBeenCalledOnce()
      // WHY: Original 401 response is returned so the caller can handle it.
      expect(result).toBe(response)
    })

    it('returns original response when session has no access_token after refresh', async () => {
      vi.mocked(supabase.auth.refreshSession).mockResolvedValue({
        data: { session: null, user: null },
        error: null,
      })
      vi.mocked(supabase.auth.getSession).mockResolvedValue({
        data: { session: null },
        error: null,
      })

      const request = buildRequest()
      const response = buildResponse(401)

      const result = await responseInterceptor(response, request, buildOptions())

      expect(result).toBe(response)
      // clear() should NOT be called — refresh succeeded, just no token
      expect(useAuthStore.getState().clear).not.toHaveBeenCalled()
    })

    it('uses globalThis.fetch when options.fetch is undefined', async () => {
      const retryResponse = buildResponse(200)
      const originalFetch = globalThis.fetch
      globalThis.fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(retryResponse)

      vi.mocked(supabase.auth.refreshSession).mockResolvedValue({
        data: { session: null, user: null },
        error: null,
      })
      vi.mocked(supabase.auth.getSession).mockResolvedValue({
        data: { session: { access_token: 'fresh-token' } as never },
        error: null,
      })

      const request = buildRequest()
      const response = buildResponse(401)

      const result = await responseInterceptor(response, request, { fetch: undefined })

      expect(globalThis.fetch).toHaveBeenCalledOnce()
      expect(result).toBe(retryResponse)

      globalThis.fetch = originalFetch
    })

    it('logs api_error breadcrumb before attempting refresh', async () => {
      vi.mocked(supabase.auth.refreshSession).mockResolvedValue({
        data: { session: null, user: null },
        error: new AuthError('expired', 401, 'session_expired'),
      })

      const request = buildRequest({ method: 'GET' })
      const response = buildResponse(401)

      await responseInterceptor(response, request, buildOptions())

      expect(logger.error).toHaveBeenCalledWith('api_error', {
        status: 401,
        method: 'GET',
        url: 'http://localhost:3000/v1/messages',
      })
    })
  })

  // -- 429: rate limit retry --------------------------------------------------

  describe('429 — rate limit retry', () => {
    it('retries after Retry-After seconds', async () => {
      vi.useFakeTimers()

      const retryResponse = buildResponse(200)
      const mockFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(retryResponse)

      const request = buildRequest()
      const response = buildResponse(429, { 'Retry-After': '2' })

      const resultPromise = responseInterceptor(response, request, buildOptions(mockFetch))

      // WHY: The interceptor calls delay(2000) — advance timers to resolve it.
      await vi.advanceTimersByTimeAsync(2000)

      const result = await resultPromise

      expect(mockFetch).toHaveBeenCalledOnce()
      expect(result).toBe(retryResponse)
    })

    it('defaults to 1 second when Retry-After header is missing', async () => {
      vi.useFakeTimers()

      const retryResponse = buildResponse(200)
      const mockFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(retryResponse)

      const request = buildRequest()
      // WHY: No Retry-After header — interceptor should default to 1000ms.
      const response = buildResponse(429)

      const resultPromise = responseInterceptor(response, request, buildOptions(mockFetch))

      await vi.advanceTimersByTimeAsync(1000)

      const result = await resultPromise

      expect(mockFetch).toHaveBeenCalledOnce()
      expect(result).toBe(retryResponse)
    })

    it('logs api_error breadcrumb for 429 responses', async () => {
      vi.useFakeTimers()

      const mockFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(buildResponse(200))

      const request = buildRequest({ method: 'POST' })
      const response = buildResponse(429, { 'Retry-After': '1' })

      const resultPromise = responseInterceptor(response, request, buildOptions(mockFetch))
      await vi.advanceTimersByTimeAsync(1000)
      await resultPromise

      expect(logger.error).toHaveBeenCalledWith('api_error', {
        status: 429,
        method: 'POST',
        url: 'http://localhost:3000/v1/messages',
      })
    })

    it('uses globalThis.fetch when options.fetch is undefined', async () => {
      vi.useFakeTimers()

      const retryResponse = buildResponse(200)
      const originalFetch = globalThis.fetch
      globalThis.fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(retryResponse)

      const request = buildRequest()
      const response = buildResponse(429, { 'Retry-After': '1' })

      const resultPromise = responseInterceptor(response, request, { fetch: undefined })
      await vi.advanceTimersByTimeAsync(1000)

      const result = await resultPromise

      expect(globalThis.fetch).toHaveBeenCalledOnce()
      expect(result).toBe(retryResponse)

      globalThis.fetch = originalFetch
    })
  })

  // -- refreshToken dedup (singleton promise) ---------------------------------

  describe('refreshToken deduplication', () => {
    it('deduplicates concurrent refresh calls into a single request', async () => {
      const retryResponse = buildResponse(200)
      const mockFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(retryResponse)

      // WHY: refreshSession resolves after a tick to simulate async behavior.
      // Both interceptor invocations should share the same promise.
      vi.mocked(supabase.auth.refreshSession).mockResolvedValue({
        data: { session: null, user: null },
        error: null,
      })
      vi.mocked(supabase.auth.getSession).mockResolvedValue({
        data: { session: { access_token: 'shared-token' } as never },
        error: null,
      })

      const request1 = buildRequest()
      const request2 = buildRequest({ url: 'http://localhost:3000/v1/channels' })
      const response1 = buildResponse(401)
      const response2 = buildResponse(401)

      // Fire two 401s concurrently — simulates parallel queries on page load.
      await Promise.all([
        responseInterceptor(response1, request1, buildOptions(mockFetch)),
        responseInterceptor(response2, request2, buildOptions(mockFetch)),
      ])

      // WHY: refreshSession must be called exactly once despite two 401s.
      expect(supabase.auth.refreshSession).toHaveBeenCalledOnce()
    })
  })
})
