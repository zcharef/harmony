import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query'
import type { GifListResponse } from '@/lib/api'
import { searchGifs } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'

/**
 * GIF search, paginated. Same shape as `use-trending-gifs`, keyed by the
 * (already-debounced) query string, and enabled only for a non-empty query.
 *
 * `placeholderData: keepPreviousData` keeps the last results on screen (dimmed
 * by the caller) while a new query refetches — TanStack keys results by query
 * string, so a stale response can never overwrite a fresher one.
 */
export function useSearchGifs(debouncedQuery: string, enabled: boolean) {
  const query = debouncedQuery.trim()
  return useInfiniteQuery({
    queryKey: queryKeys.gifs.search(query),
    queryFn: async ({ pageParam }) => {
      const { data } = await searchGifs({
        query: { q: query, page: pageParam },
        throwOnError: true,
      })
      return data
    },
    initialPageParam: 1,
    getNextPageParam: (lastPage: GifListResponse) =>
      lastPage.hasNext ? lastPage.page + 1 : undefined,
    enabled: enabled && query.length > 0,
    placeholderData: keepPreviousData,
  })
}
