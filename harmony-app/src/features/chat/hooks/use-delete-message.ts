import { useMutation, useQueryClient } from '@tanstack/react-query'
import { deleteMessage } from '@/lib/api'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'

/**
 * WHY invalidation: Same rationale as use-edit-message — delete is low-frequency.
 * The realtime UPDATE handler (soft-delete sets deleted_at) will also remove
 * the message from cache, but invalidation ensures consistency if realtime lags.
 */
export function useDeleteMessage(channelId: string) {
  const queryClient = useQueryClient()
  const messageQueryKey = queryKeys.messages.byChannel(channelId)

  return useMutation({
    mutationFn: async (messageId: string) => {
      await deleteMessage({
        path: { channel_id: channelId, message_id: messageId },
        throwOnError: true,
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: messageQueryKey })
    },
    onError: (error) => {
      logger.error('Failed to delete message', {
        channelId,
        error: error instanceof Error ? error.message : String(error),
      })
    },
  })
}
