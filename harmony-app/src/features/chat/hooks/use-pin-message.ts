import type { InfiniteData } from '@tanstack/react-query'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import i18n from 'i18next'
import type { MessageListResponse } from '@/lib/api'
import { pinMessage } from '@/lib/api'
import { getApiErrorDetail, isProblemDetails } from '@/lib/api-error'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'
import { toast } from '@/lib/toast'
import { patchMessagePinned } from './pins-cache'

/**
 * WHY status-mapped: a moderator forging a pin they can't perform gets a 403,
 * and hitting the channel pin cap gets a 409 — each maps to a specific, actionable
 * message (Error Feedback Matrix). Everything else falls back to the API `detail`.
 */
export function pinErrorToast(error: unknown, fallbackKey: string): string {
  if (isProblemDetails(error)) {
    if (error.status === 403) return i18n.t('chat:pinForbidden')
    if (error.status === 409) return i18n.t('chat:pinLimitReached')
  }
  return getApiErrorDetail(error, i18n.t(fallbackKey))
}

/**
 * Pins a message (moderator+). Optimistically flips `isPinned` in the message
 * cache for instant inline feedback; rolls back on error. The pins panel + the
 * confirmed flag reconcile via the `message.pinned` SSE echo (delivered to the
 * sender too — pins are NOT self-echo-suppressed), so there is no invalidate.
 */
export function usePinMessage(channelId: string) {
  const queryClient = useQueryClient()
  const messageQueryKey = queryKeys.messages.byChannel(channelId)

  return useMutation({
    mutationFn: async (messageId: string) => {
      await pinMessage({
        path: { channel_id: channelId, message_id: messageId },
        throwOnError: true,
      })
    },

    onMutate: async (messageId: string) => {
      await queryClient.cancelQueries({ queryKey: messageQueryKey })
      const previousMessages =
        queryClient.getQueryData<InfiniteData<MessageListResponse>>(messageQueryKey)

      queryClient.setQueryData<InfiniteData<MessageListResponse>>(messageQueryKey, (old) =>
        patchMessagePinned(old, messageId, true),
      )

      return { previousMessages }
    },

    onError: (error, _messageId, context) => {
      logger.error('pin_message_failed', {
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
