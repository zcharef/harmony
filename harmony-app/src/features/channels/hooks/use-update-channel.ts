import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { UpdateChannelRequest } from '@/lib/api'
import { updateChannel } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'

/**
 * WHY: Wraps updateChannel SDK in a mutation with automatic cache
 * invalidation so the channel list refreshes after edits.
 */
export function useUpdateChannel(serverId: string, channelId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (input: UpdateChannelRequest) => {
      const { data } = await updateChannel({
        path: { id: serverId, channel_id: channelId },
        body: input,
        throwOnError: true,
      })
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.channels.byServer(serverId) })
    },
  })
}
