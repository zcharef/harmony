import type { InfiniteData } from '@tanstack/react-query'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import i18n from 'i18next'
import type { MessageListResponse } from '@/lib/api'
import { deleteMessage } from '@/lib/api'
import { getApiErrorDetail } from '@/lib/api-error'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'
import { toast } from '@/lib/toast'

/**
 * WHY setQueryData instead of invalidateQueries: The API filters soft-deleted
 * messages from list queries. Refetching after delete would remove the message
 * entirely from the cache instead of showing the "[Message deleted]" tombstone.
 * Setting `deletedBy` in-place matches the SSE handler pattern and gives
 * instant visual feedback.
 */
export function useDeleteMessage(channelId: string, currentUserId: string) {
  const queryClient = useQueryClient()
  const messageQueryKey = queryKeys.messages.byChannel(channelId)

  return useMutation({
    mutationFn: async (messageId: string) => {
      await deleteMessage({
        path: { channel_id: channelId, message_id: messageId },
        throwOnError: true,
      })
    },
    onSuccess: (_data, messageId) => {
      queryClient.setQueryData<InfiniteData<MessageListResponse>>(messageQueryKey, (old) => {
        if (!old) return undefined
        return {
          ...old,
          pages: old.pages.map((page) => ({
            ...page,
            items: page.items.map((m) => {
              if (m.id === messageId) {
                return { ...m, deletedBy: currentUserId }
              }
              if (m.parentMessage?.id === messageId) {
                return {
                  ...m,
                  parentMessage: {
                    ...m.parentMessage,
                    deleted: true,
                    contentPreview: '',
                    authorUsername: '',
                  },
                }
              }
              return m
            }),
          })),
        }
      })
    },
    onError: (error) => {
      logger.error('Failed to delete message', {
        channelId,
        error: error instanceof Error ? error.message : String(error),
      })
      toast.error(getApiErrorDetail(error, i18n.t('chat:deleteMessageFailed')))
    },
  })
}
