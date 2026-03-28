import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ServerId } from '@/lib/api'
import { closeDm } from '@/lib/api'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'

/**
 * WHY: Wraps closeDm SDK in a mutation with automatic cache invalidation.
 * Invalidates both DM list and server list since DMs are servers.
 */
export function useCloseDm() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (serverId: ServerId) => {
      await closeDm({
        path: { server_id: serverId },
        throwOnError: true,
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.dms.all })
      queryClient.invalidateQueries({ queryKey: queryKeys.servers.all })
    },
    onError: (error) => {
      logger.error('Failed to close DM', {
        error: error instanceof Error ? error.message : String(error),
      })
    },
  })
}
