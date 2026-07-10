import { useQuery } from '@tanstack/react-query'
import { getMigrationProgress } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'

/** WHY 30s: migration progress moves on the scale of members joining and
 * chatting, not seconds. Polling keeps the owner's dashboard fresh while they
 * watch it, without any realtime plumbing (progress tolerates staleness). */
const PROGRESS_POLL_MS = 30_000

/**
 * WHY: Wraps the getMigrationProgress SDK call in TanStack Query. Fetches the
 * owner-facing "alive server" progress + follow-through counts for one server.
 * Disabled until a serverId is selected.
 */
export function useMigrationProgress(serverId: string | null) {
  return useQuery({
    queryKey: queryKeys.servers.migrationProgress(serverId ?? ''),
    queryFn: async () => {
      // WHY: `enabled` guard ensures serverId is non-null when queryFn runs.
      if (serverId === null) throw new Error('serverId is required')
      const { data } = await getMigrationProgress({
        path: { id: serverId },
        throwOnError: true,
      })
      return data
    },
    enabled: serverId !== null,
    refetchInterval: PROGRESS_POLL_MS,
  })
}
