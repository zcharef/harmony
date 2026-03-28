import { useQuery } from '@tanstack/react-query'
import { listServers } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'

/**
 * WHY: Wraps the listServers SDK call in TanStack Query for caching,
 * deduplication, and background refetching. Returns the user's servers.
 */
export function useServers() {
  return useQuery({
    queryKey: queryKeys.servers.list(),
    queryFn: async () => {
      const { data } = await listServers({ throwOnError: true })
      return data.items
    },
  })
}
