import { useInfiniteQuery } from '@tanstack/react-query'
import type { GifListResponse } from '@/lib/api'
import { trendingGifs } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'

/**
 * Trending GIFs, paginated. Mirrors `use-messages.ts`: `useInfiniteQuery` with
 * `throwOnError: true` (mandatory per the openapi-web-safety skill) and
 * `getNextPageParam` reading the server's `hasNext` flag.
 *
 * `enabled` is gated so no request fires when the picker is closed or the
 * feature is off.
 */
export function useTrendingGifs(enabled: boolean) {
  return useInfiniteQuery({
    queryKey: queryKeys.gifs.trending(),
    queryFn: async ({ pageParam }) => {
      const { data } = await trendingGifs({ query: { page: pageParam }, throwOnError: true })
      return data
    },
    initialPageParam: 1,
    getNextPageParam: (lastPage: GifListResponse) =>
      lastPage.hasNext ? lastPage.page + 1 : undefined,
    enabled,
  })
}
