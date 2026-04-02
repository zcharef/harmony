import type { InfiniteData } from '@tanstack/react-query'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import i18n from 'i18next'
import type { MessageListResponse, ReactionSummary } from '@/lib/api'
import { addReaction } from '@/lib/api'
import { getApiErrorDetail } from '@/lib/api-error'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'
import { toast } from '@/lib/toast'

/**
 * WHY: Mutation hook for adding a reaction to a message.
 * Optimistically updates the message cache so the reaction appears
 * instantly, then rolls back on error.
 */
export function useAddReaction(channelId: string) {
  const queryClient = useQueryClient()
  const messageQueryKey = queryKeys.messages.byChannel(channelId)

  return useMutation({
    mutationFn: async ({ messageId, emoji }: { messageId: string; emoji: string }) => {
      await addReaction({
        path: { channel_id: channelId, message_id: messageId },
        body: { emoji },
        throwOnError: true,
      })
    },

    onMutate: async ({ messageId, emoji }) => {
      await queryClient.cancelQueries({ queryKey: messageQueryKey })
      const previousData =
        queryClient.getQueryData<InfiniteData<MessageListResponse>>(messageQueryKey)

      queryClient.setQueryData<InfiniteData<MessageListResponse>>(messageQueryKey, (old) => {
        if (!old) return undefined
        return {
          ...old,
          pages: old.pages.map((page) => ({
            ...page,
            items: page.items.map((m) => {
              if (m.id !== messageId) return m
              const existing = (m.reactions ?? []).find((r) => r.emoji === emoji)
              let reactions: Array<ReactionSummary>
              if (existing !== undefined) {
                reactions = (m.reactions ?? []).map((r) =>
                  r.emoji === emoji ? { ...r, count: r.count + 1, reactedByMe: true } : r,
                )
              } else {
                reactions = [...(m.reactions ?? []), { emoji, count: 1, reactedByMe: true }]
              }
              return { ...m, reactions }
            }),
          })),
        }
      })

      return { previousData }
    },

    onError: (error, _variables, context) => {
      logger.error('add_reaction_failed', {
        channelId,
        error: error instanceof Error ? error.message : String(error),
      })
      toast.error(getApiErrorDetail(error, i18n.t('chat:addReactionFailed')))
      if (context?.previousData) {
        queryClient.setQueryData(messageQueryKey, context.previousData)
      }
    },

    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: messageQueryKey })
    },
  })
}
