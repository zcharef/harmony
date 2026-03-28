import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { CreateChannelRequest } from '@/lib/api'
import { createChannel } from '@/lib/api'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'

/**
 * WHY: Wraps createChannel SDK in a mutation with automatic cache
 * invalidation so the channel list refreshes after creation.
 */
export function useCreateChannel(serverId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (input: CreateChannelRequest) => {
      const { data } = await createChannel({
        path: { id: serverId },
        body: input,
        throwOnError: true,
      })
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.channels.byServer(serverId) })
    },
    onError: (error) => {
      logger.error('create_channel_failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    },
  })
}
