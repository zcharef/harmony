import type { InfiniteData } from '@tanstack/react-query'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { MessageListResponse } from '@/lib/api'
import { unpinMessage } from '@/lib/api'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'
import { toast } from '@/lib/toast'
import { patchMessagePinned } from './pins-cache'
import { pinErrorToast } from './use-pin-message'

/**
 * Unpins a message (moderator+). Optimistically clears `isPinned` in the message
 * cache; rolls back on error. The pins panel + the confirmed flag reconcile via
 * the `message.unpinned` SSE echo (delivered to the sender too), so no invalidate.
 */
export function useUnpinMessage(channelId: string) {
  const queryClient = useQueryClient()
  const messageQueryKey = queryKeys.messages.byChannel(channelId)

  return useMutation({
    mutationFn: async (messageId: string) => {
      await unpinMessage({
        path: { channel_id: channelId, message_id: messageId },
        throwOnError: true,
      })
    },

    onMutate: async (messageId: string) => {
      await queryClient.cancelQueries({ queryKey: messageQueryKey })
      const previousMessages =
        queryClient.getQueryData<InfiniteData<MessageListResponse>>(messageQueryKey)

      queryClient.setQueryData<InfiniteData<MessageListResponse>>(messageQueryKey, (old) =>
        patchMessagePinned(old, messageId, false),
      )

      return { previousMessages }
    },

    onError: (error, _messageId, context) => {
      logger.error('unpin_message_failed', {
        channelId,
        error: error instanceof Error ? error.message : String(error),
      })
      toast.error(pinErrorToast(error, 'chat:pinActionFailed'))
      if (context?.previousMessages) {
        queryClient.setQueryData(messageQueryKey, context.previousMessages)
      }
    },
  })
}
