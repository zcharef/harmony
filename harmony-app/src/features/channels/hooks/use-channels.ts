import { useQuery } from '@tanstack/react-query'
import { listChannels } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'

/**
 * WHY: Wraps listChannels SDK call in TanStack Query.
 * Fetches channels for a specific server. Disabled when no serverId
 * is provided (avoids firing requests before server selection).
 */
export function useChannels(serverId: string | null) {
  return useQuery({
    queryKey: queryKeys.channels.byServer(serverId ?? ''),
    queryFn: async () => {
      // WHY: `enabled` guard ensures serverId is non-null when queryFn runs
      if (serverId === null) throw new Error('serverId is required')
      const { data } = await listChannels({
        path: { id: serverId },
        throwOnError: true,
      })
      return data.items
    },
    enabled: serverId !== null,
  })
}
