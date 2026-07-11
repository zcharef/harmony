import { useQuery } from '@tanstack/react-query'
import { listFriends } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'

/**
 * The caller's friends, pre-sorted by username (server-side, §3.1). Whole
 * bounded list — plain `useQuery`, never `useInfiniteQuery`. Returns the
 * envelope's `items` array (matches the `useDms` pattern).
 */
export function useFriends() {
  return useQuery({
    queryKey: queryKeys.friends.list(),
    queryFn: async () => {
      const { data } = await listFriends({ throwOnError: true })
      return data.items
    },
  })
}
