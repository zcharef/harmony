import type { InfiniteData } from '@tanstack/react-query'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import i18n from 'i18next'
import type { MessageListResponse } from '@/lib/api'
import { removeMessageEmbed } from '@/lib/api'
import { getApiErrorDetail } from '@/lib/api-error'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'
import { toast } from '@/lib/toast'

/**
 * Remove (suppress) a link preview from a message.
 *
 * WHY setQueryData instead of invalidateQueries: matches the SSE handler
 * pattern — the caller's own cache patches instantly; everyone else receives
 * the server's message.updated (full message) fan-out. The suppression is
 * persisted server-side, so the preview never re-unfurls.
 */
export function useRemoveEmbed(channelId: string) {
  const queryClient = useQueryClient()
  const messageQueryKey = queryKeys.messages.byChannel(channelId)

  return useMutation({
    mutationFn: async ({ messageId, embedId }: { messageId: string; embedId: string }) => {
      await removeMessageEmbed({
        path: { channel_id: channelId, message_id: messageId, embed_id: embedId },
        throwOnError: true,
      })
    },
    onSuccess: (_data, { messageId, embedId }) => {
      queryClient.setQueryData<InfiniteData<MessageListResponse>>(messageQueryKey, (old) => {
        if (!old) return undefined
        return {
          ...old,
          pages: old.pages.map((page) => ({
            ...page,
            items: page.items.map((m) => {
              if (m.id !== messageId) return m
              return { ...m, embeds: m.embeds.filter((e) => e.id !== embedId) }
            }),
          })),
        }
      })
    },
    onError: (error) => {
      logger.error('Failed to remove link preview', {
        channelId,
        error: error instanceof Error ? error.message : String(error),
      })
      toast.error(getApiErrorDetail(error, i18n.t('chat:removePreviewFailed')))
    },
  })
}
