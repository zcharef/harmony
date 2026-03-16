import { useQuery } from '@tanstack/react-query'
import { listMembers } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'

/**
 * WHY: Wraps listMembers SDK call in TanStack Query.
 * Fetches members for a specific server. Disabled when no serverId
 * is provided (avoids firing requests before server selection).
 */
export function useMembers(serverId: string | null) {
  return useQuery({
    queryKey: queryKeys.servers.members(serverId ?? ''),
    queryFn: async () => {
      // WHY: `enabled` guard ensures serverId is non-null when queryFn runs
      if (serverId === null) throw new Error('serverId is required')
      const { data } = await listMembers({
        path: { id: serverId },
        throwOnError: true,
      })
      return data
    },
    enabled: serverId !== null,
  })
}
