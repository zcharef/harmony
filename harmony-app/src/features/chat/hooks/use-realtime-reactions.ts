import type { InfiniteData } from '@tanstack/react-query'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { z } from 'zod'
import { useServerEvent } from '@/hooks/use-server-event'
import type { MessageListResponse, ReactionSummary } from '@/lib/api'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'

/**
 * Must match the server's `rn <= 10` bound in
 * `PgReactionRepository::batch_for_messages`. The tooltip shows at most this
 * many names, then "+N others"; the SSE patch never grows the list past it.
 */
const VISUAL_REACTOR_CAP = 10

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
  displayName: z.string().nullish(),
})

const reactionRemovedSchema = z.object({
  channelId: z.string(),
  messageId: z.string(),
  emoji: z.string(),
  userId: z.string(),
  username: z.string(),
})

interface ReactorPatch {
  emoji: string
  username: string
  displayName?: string | null
  isSelf: boolean
}

/**
 * Pure reducer for one message's reaction summaries on `reaction.added`.
 * New emoji → a fresh summary seeded with the reactor. Existing emoji →
 * count +1 and the reactor appended, unless already present (idempotent echo /
 * optimistic self-add) or the visible cap is reached.
 */
function applyReactionAdded(
  reactions: Array<ReactionSummary>,
  { emoji, username, displayName, isSelf }: ReactorPatch,
): Array<ReactionSummary> {
  const existing = reactions.find((r) => r.emoji === emoji)
  if (existing === undefined) {
    return [
      ...reactions,
      { emoji, count: 1, reactedByMe: isSelf, reactors: [{ username, displayName }] },
    ]
  }
  return reactions.map((r) => {
    if (r.emoji !== emoji) return r
    const already = r.reactors.some((rr) => rr.username === username)
    const reactors =
      already || r.reactors.length >= VISUAL_REACTOR_CAP
        ? r.reactors
        : [...r.reactors, { username, displayName }]
    return { ...r, count: r.count + 1, reactedByMe: r.reactedByMe || isSelf, reactors }
  })
}

/**
 * Pure reducer for one message's reaction summaries on `reaction.removed`.
 * Count -1, the matching reactor dropped by username, and the summary removed
 * once it hits zero. A remover beyond the visible first-10 is a no-op on the
 * list (the name self-heals on the next message-list fetch).
 */
function applyReactionRemoved(
  reactions: Array<ReactionSummary>,
  { emoji, username, isSelf }: Omit<ReactorPatch, 'displayName'>,
): Array<ReactionSummary> {
  return reactions
    .map((r) =>
      r.emoji === emoji
        ? {
            ...r,
            count: r.count - 1,
            reactedByMe: isSelf ? false : r.reactedByMe,
            reactors: r.reactors.filter((rr) => rr.username !== username),
          }
        : r,
    )
    .filter((r) => r.count > 0)
}

/** Applies a per-message reactions reducer across the infinite-query cache. */
function patchMessageReactions(
  old: InfiniteData<MessageListResponse> | undefined,
  messageId: string,
  reduce: (reactions: Array<ReactionSummary>) => Array<ReactionSummary>,
): InfiniteData<MessageListResponse> | undefined {
  if (!old) return undefined
  return {
    ...old,
    pages: old.pages.map((page) => ({
      ...page,
      items: page.items.map((m) =>
        m.id === messageId ? { ...m, reactions: reduce(m.reactions ?? []) } : m,
      ),
    })),
  }
}

/**
 * Subscribes to SSE reaction events for a given channel and updates
 * the TanStack Query message cache on:
 * - reaction.added: upsert emoji count + reactor list on the target message
 * - reaction.removed: decrement emoji count, drop the reactor, remove entry if 0
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

      const { messageId, emoji, userId, username, displayName } = parsed.data
      queryClient.setQueryData<InfiniteData<MessageListResponse>>(
        queryKeys.messages.byChannel(safeChannelId),
        (old) =>
          patchMessageReactions(old, messageId, (reactions) =>
            applyReactionAdded(reactions, {
              emoji,
              username,
              displayName,
              isSelf: userId === currentUserId,
            }),
          ),
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

      const { messageId, emoji, userId, username } = parsed.data
      queryClient.setQueryData<InfiniteData<MessageListResponse>>(
        queryKeys.messages.byChannel(safeChannelId),
        (old) =>
          patchMessageReactions(old, messageId, (reactions) =>
            applyReactionRemoved(reactions, {
              emoji,
              username,
              isSelf: userId === currentUserId,
            }),
          ),
      )
    },
    [safeChannelId, queryClient, currentUserId],
  )

  useServerEvent(safeChannelId.length > 0 ? 'reaction.added' : null, handleReactionAdded)
  useServerEvent(safeChannelId.length > 0 ? 'reaction.removed' : null, handleReactionRemoved)
}
