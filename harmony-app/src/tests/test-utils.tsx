import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, type RenderHookOptions } from '@testing-library/react'
import type { ReactNode } from 'react'

/**
 * Creates a fresh QueryClient configured for tests.
 *
 * WHY: Tests need isolated query caches to prevent cross-test pollution.
 * Retries are disabled to make failures deterministic.
 */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
      },
      mutations: {
        retry: false,
      },
    },
  })
}

/**
 * Wraps a hook in QueryClientProvider for testing.
 *
 * Usage:
 *   const { result } = renderHook(() => useMyHook(), {
 *     wrapper: createQueryWrapper(),
 *   })
 */
export function createQueryWrapper(queryClient?: QueryClient) {
  const client = queryClient ?? createTestQueryClient()

  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
}

/**
 * Convenience: renderHook pre-wrapped with QueryClientProvider.
 * Returns the QueryClient for cache assertions.
 */
export function renderHookWithQueryClient<TResult>(
  hook: () => TResult,
  options?: Omit<RenderHookOptions<unknown>, 'wrapper'>,
) {
  const queryClient = createTestQueryClient()
  const wrapper = createQueryWrapper(queryClient)

  const renderResult = renderHook(hook, { ...options, wrapper })

  return { ...renderResult, queryClient }
}
