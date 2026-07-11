import { useInfiniteQuery } from '@tanstack/react-query'
import { listDiscoveryServers } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'

/** WHY a typed const (not `as`): ADR-035 bans `as Type` assertions. */
const INITIAL_CURSOR: string | undefined = undefined

/**
 * Directory listing with keyset pagination — one infinite query per
 * (search, category) combination. The API only ever returns opted-in
 * servers, featured first then by member count.
 */
export function useDiscoveryServers(search: string, category: string | null) {
  return useInfiniteQuery({
    queryKey: queryKeys.discovery.list(search, category),
    queryFn: async ({ pageParam }) => {
      const { data } = await listDiscoveryServers({
        query: {
          ...(search === '' ? {} : { q: search }),
          ...(category === null ? {} : { category }),
          ...(pageParam === undefined ? {} : { cursor: pageParam }),
        },
        throwOnError: true,
      })
      return data
    },
    initialPageParam: INITIAL_CURSOR,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  })
}
