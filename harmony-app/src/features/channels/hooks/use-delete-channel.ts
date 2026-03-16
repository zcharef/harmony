import { useMutation, useQueryClient } from '@tanstack/react-query'
import { deleteChannel } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'

/**
 * WHY: Wraps deleteChannel SDK in a mutation with automatic cache
 * invalidation so the channel list refreshes after deletion.
 */
export function useDeleteChannel(serverId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (channelId: string) => {
      await deleteChannel({
        path: { id: serverId, channel_id: channelId },
        throwOnError: true,
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.channels.byServer(serverId) })
    },
  })
}
