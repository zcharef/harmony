import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { listBans, unbanMember } from '@/lib/api'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'

/** WHY: Fetches the ban list for server settings display. */
export function useBans(serverId: string) {
  return useQuery({
    queryKey: queryKeys.servers.bans(serverId),
    queryFn: async () => {
      const { data } = await listBans({
        path: { id: serverId },
        throwOnError: true,
      })
      return data
    },
  })
}

/** WHY: Wraps unbanMember SDK call with cache invalidation for the ban list. */
export function useUnbanMember(serverId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (userId: string) => {
      await unbanMember({
        path: { id: serverId, user_id: userId },
        throwOnError: true,
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.servers.bans(serverId) })
      queryClient.invalidateQueries({ queryKey: queryKeys.servers.members(serverId) })
    },
    onError: (error) => {
      logger.error('Failed to unban member', {
        serverId,
        error: error instanceof Error ? error.message : String(error),
      })
    },
  })
}
