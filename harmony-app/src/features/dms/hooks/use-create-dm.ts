import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { UserId } from '@/lib/api'
import { createDm } from '@/lib/api'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'

/**
 * WHY: Wraps createDm SDK in a mutation with automatic cache invalidation
 * so the DM list refreshes after creation. Also invalidates the server list
 * because DMs are servers with isDm=true.
 */
export function useCreateDm() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (recipientId: UserId) => {
      const { data } = await createDm({
        body: { recipientId },
        throwOnError: true,
      })
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.dms.all })
      queryClient.invalidateQueries({ queryKey: queryKeys.servers.all })
    },
    onError: (error) => {
      logger.error('Failed to create DM', {
        error: error instanceof Error ? error.message : String(error),
      })
    },
  })
}
