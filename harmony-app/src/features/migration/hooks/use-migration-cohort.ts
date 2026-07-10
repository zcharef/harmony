import { useQuery } from '@tanstack/react-query'
import { listNotYetActiveCohort } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'

/** First-page size for the not-yet-active cohort. */
const COHORT_PAGE_SIZE = 25

/**
 * WHY: Wraps the listNotYetActiveCohort SDK call in TanStack Query. Fetches the
 * first page of members who joined but haven't participated yet (the owner's
 * intervention targets). Disabled until a serverId is selected.
 */
export function useMigrationCohort(serverId: string | null) {
  return useQuery({
    queryKey: queryKeys.servers.migrationCohort(serverId ?? ''),
    queryFn: async () => {
      // WHY: `enabled` guard ensures serverId is non-null when queryFn runs.
      if (serverId === null) throw new Error('serverId is required')
      const { data } = await listNotYetActiveCohort({
        path: { id: serverId },
        query: { limit: COHORT_PAGE_SIZE },
        throwOnError: true,
      })
      return data
    },
    enabled: serverId !== null,
  })
}
