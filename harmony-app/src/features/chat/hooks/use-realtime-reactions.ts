import type { InfiniteData } from '@tanstack/react-query'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { z } from 'zod'
import { useServerEvent } from '@/hooks/use-server-event'
import type { MessageListResponse, ReactionSummary } from '@/lib/api'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'

/**
 * WHY local schemas: useEventSource already validates the full discriminated
 * union via serverEventSchema. These local schemas validate only the subset
 * of fields needed for cache mutation.
 */
const reactionAddedSchema = z.object({
  channelId: z.string(),
  messageId: z.string(),
  emoji: z.string(),
  userId: z.string(),
  username: z.string(),
})

const reactionRemovedSchema = z.object({
  channelId: z.string(),
  messageId: z.string(),
  emoji: z.string(),
  userId: z.string(),
})

/**
 * Subscribes to SSE reaction events for a given channel and updates
 * the TanStack Query message cache on:
 * - reaction.added: upsert emoji count on the target message
 * - reaction.removed: decrement emoji count (remove entry if 0)
 *
 * WHY direct cache update instead of invalidation: avoids a network
 * round-trip per reaction, keeping the UI instant.
 */
export function useRealtimeReactions(channelId: string | null, currentUserId: string) {
  const queryClient = useQueryClient()
  const safeChannelId = channelId ?? ''

  const handleReactionAdded = useCallback(
    (payload: unknown) => {
      if (safeChannelId.length === 0) return

      const parsed = reactionAddedSchema.safeParse(payload)
      if (!parsed.success) {
        logger.error('Malformed reaction.added SSE payload', {
          channelId: safeChannelId,
          error: parsed.error.message,
        })
        return
      }

      if (parsed.data.channelId !== safeChannelId) return

      const { messageId, emoji, userId } = parsed.data

      queryClient.setQueryData<InfiniteData<MessageListResponse>>(
        queryKeys.messages.byChannel(safeChannelId),
        (old) => {
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
                    r.emoji === emoji
                      ? {
                          ...r,
                          count: r.count + 1,
                          reactedByMe: r.reactedByMe || userId === currentUserId,
                        }
                      : r,
                  )
                } else {
                  reactions = [
                    ...(m.reactions ?? []),
                    { emoji, count: 1, reactedByMe: userId === currentUserId },
                  ]
                }
                return { ...m, reactions }
              }),
            })),
          }
        },
      )
    },
    [safeChannelId, queryClient, currentUserId],
  )

  const handleReactionRemoved = useCallback(
    (payload: unknown) => {
      if (safeChannelId.length === 0) return

      const parsed = reactionRemovedSchema.safeParse(payload)
      if (!parsed.success) {
        logger.error('Malformed reaction.removed SSE payload', {
          channelId: safeChannelId,
          error: parsed.error.message,
        })
        return
      }

      if (parsed.data.channelId !== safeChannelId) return

      const { messageId, emoji, userId } = parsed.data

      queryClient.setQueryData<InfiniteData<MessageListResponse>>(
        queryKeys.messages.byChannel(safeChannelId),
        (old) => {
          if (!old) return undefined
          return {
            ...old,
            pages: old.pages.map((page) => ({
              ...page,
              items: page.items.map((m) => {
                if (m.id !== messageId) return m
                const reactions: Array<ReactionSummary> = (m.reactions ?? [])
                  .map((r) =>
                    r.emoji === emoji
                      ? {
                          ...r,
                          count: r.count - 1,
                          reactedByMe: userId === currentUserId ? false : r.reactedByMe,
                        }
                      : r,
                  )
                  .filter((r) => r.count > 0)
                return { ...m, reactions }
              }),
            })),
          }
        },
      )
    },
    [safeChannelId, queryClient, currentUserId],
  )

  useServerEvent(safeChannelId.length > 0 ? 'reaction.added' : null, handleReactionAdded)
  useServerEvent(safeChannelId.length > 0 ? 'reaction.removed' : null, handleReactionRemoved)
}
