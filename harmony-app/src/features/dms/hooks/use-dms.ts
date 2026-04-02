import { useQuery } from '@tanstack/react-query'
import { listDms } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'

/**
 * WHY: Wraps the listDms SDK call in TanStack Query for caching and
 * deduplication. Returns the user's DM conversations sorted by most
 * recent activity.
 */
export function useDms() {
  return useQuery({
    queryKey: queryKeys.dms.list(),
    queryFn: async () => {
      const { data } = await listDms({ throwOnError: true })
      return data.items
    },
  })
}
