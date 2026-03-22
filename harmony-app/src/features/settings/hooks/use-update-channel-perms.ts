import { useMutation, useQueryClient } from '@tanstack/react-query'
import { client } from '@/lib/api/client.gen'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'

interface UpdateChannelPermsInput {
  isPrivate?: boolean
  isReadOnly?: boolean
}

/**
 * WHY: The generated UpdateChannelRequest type does not include is_private/is_read_only
 * yet. Uses the raw client to send these fields until `just gen-api` regenerates.
 * Once regenerated, this can use the standard updateChannel SDK call.
 */
export function useUpdateChannelPerms(serverId: string, channelId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (input: UpdateChannelPermsInput) => {
      const { error } = await client.patch({
        url: '/v1/servers/{id}/channels/{channel_id}',
        path: { id: serverId, channel_id: channelId },
        body: { is_private: input.isPrivate, is_read_only: input.isReadOnly },
        headers: { 'Content-Type': 'application/json' },
        security: [{ scheme: 'bearer', type: 'http' }],
      })
      if (error) throw error
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.channels.byServer(serverId) })
    },
    onError: (error) => {
      logger.error('Failed to update channel permissions', {
        serverId,
        channelId,
        error: error instanceof Error ? error.message : String(error),
      })
    },
  })
}
