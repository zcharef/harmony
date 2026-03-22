import { useMutation, useQueryClient } from '@tanstack/react-query'
import { transferOwnership } from '@/lib/api'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'

/**
 * WHY: Wraps the generated transferOwnership SDK call in a mutation.
 * On success, invalidates members (roles change) and server detail (owner changes).
 */
export function useTransferOwnership(serverId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (newOwnerId: string) => {
      const { data } = await transferOwnership({
        path: { id: serverId },
        body: { newOwnerId },
        throwOnError: true,
      })
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.servers.members(serverId) })
      queryClient.invalidateQueries({ queryKey: queryKeys.servers.detail(serverId) })
      queryClient.invalidateQueries({ queryKey: queryKeys.servers.all })
    },
    onError: (error) => {
      logger.error('Failed to transfer ownership', {
        serverId,
        error: error instanceof Error ? error.message : String(error),
      })
    },
  })
}
