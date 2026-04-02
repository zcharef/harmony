import type { InfiniteData } from '@tanstack/react-query'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import i18n from 'i18next'
import type { MessageListResponse, ReactionSummary } from '@/lib/api'
import { removeReaction } from '@/lib/api'
import { getApiErrorDetail } from '@/lib/api-error'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'
import { toast } from '@/lib/toast'

/**
 * WHY: Mutation hook for removing a reaction from a message.
 * Optimistically updates the message cache so the reaction disappears
 * instantly, then rolls back on error.
 */
export function useRemoveReaction(channelId: string) {
  const queryClient = useQueryClient()
  const messageQueryKey = queryKeys.messages.byChannel(channelId)

  return useMutation({
    mutationFn: async ({ messageId, emoji }: { messageId: string; emoji: string }) => {
      await removeReaction({
        path: { channel_id: channelId, message_id: messageId, emoji },
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
              const reactions: Array<ReactionSummary> = (m.reactions ?? [])
                .map((r) =>
                  r.emoji === emoji ? { ...r, count: r.count - 1, reactedByMe: false } : r,
                )
                .filter((r) => r.count > 0)
              return { ...m, reactions }
            }),
          })),
        }
      })

      return { previousData }
    },

    onError: (error, _variables, context) => {
      logger.error('remove_reaction_failed', {
        channelId,
        error: error instanceof Error ? error.message : String(error),
      })
      toast.error(getApiErrorDetail(error, i18n.t('chat:removeReactionFailed')))
      if (context?.previousData) {
        queryClient.setQueryData(messageQueryKey, context.previousData)
      }
    },

    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: messageQueryKey })
    },
  })
}
