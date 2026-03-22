import type { InfiniteData } from '@tanstack/react-query'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { z } from 'zod'
import type { MessageListResponse, MessageResponse } from '@/lib/api'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'
import { supabase } from '@/lib/supabase'

/**
 * WHY Zod: Supabase Realtime payloads are external data from a WebSocket.
 * CLAUDE.md §1.2 mandates Zod validation for all external data. Without it,
 * a malformed payload would produce a corrupt MessageResponse silently
 * inserted into the cache. The `as Type` casts the review flagged (ARCH-2)
 * are replaced by parse-or-reject.
 */
const realtimeMessageSchema = z.object({
  id: z.string(),
  channel_id: z.string(),
  author_id: z.string(),
  content: z.string(),
  created_at: z.string(),
  edited_at: z.string().nullable().optional(),
  deleted_at: z.string().nullable().optional(),
  deleted_by: z.string().nullable().optional(),
})

/**
 * WHY: Transform validated snake_case DB row to camelCase MessageResponse.
 * Separated from the schema so the mapping is explicit and type-safe.
 */
function toMessageResponse(row: z.infer<typeof realtimeMessageSchema>): MessageResponse {
  return {
    id: row.id,
    channelId: row.channel_id,
    authorId: row.author_id,
    content: row.content,
    createdAt: row.created_at,
    editedAt: row.edited_at ?? undefined,
    deletedBy: row.deleted_by ?? undefined,
  }
}

/**
 * Subscribes to Supabase Realtime Postgres Changes for messages
 * in a given channel, and updates the TanStack Query cache on:
 * - INSERT: new message prepended to page 0
 * - UPDATE: edited message replaced in-place, or removed if soft-deleted
 *
 * WHY direct cache update instead of invalidation: avoids a network
 * round-trip per message, keeping the chat feel instant.
 *
 * WHY page 0 (first page): useInfiniteQuery stores pages newest-first.
 * Page 0 contains the most recent messages, so new realtime messages
 * are prepended to page 0's items array.
 */
export function useRealtimeMessages(channelId: string) {
  const queryClient = useQueryClient()

  useEffect(() => {
    // WHY: Empty channelId means no channel selected — don't subscribe
    if (channelId.length === 0) return

    const channel = supabase
      .channel(`messages:${channelId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `channel_id=eq.${channelId}`,
        },
        (payload) => {
          const parsed = realtimeMessageSchema.safeParse(payload.new)
          if (!parsed.success) {
            logger.error('Malformed realtime message payload', {
              channelId,
              error: parsed.error.message,
            })
            return
          }

          const message = toMessageResponse(parsed.data)

          queryClient.setQueryData<InfiniteData<MessageListResponse>>(
            queryKeys.messages.byChannel(channelId),
            (old) => {
              if (!old) return undefined

              const firstPage = old.pages[0]
              if (!firstPage) return old

              // WHY: Deduplicate — useFlatMessages also dedupes, but skipping
              // the cache update entirely is cheaper than inserting then filtering.
              const alreadyExists = firstPage.items.some((m) => m.id === message.id)
              if (alreadyExists) return old

              return {
                ...old,
                pages: [
                  { ...firstPage, items: [message, ...firstPage.items] },
                  ...old.pages.slice(1),
                ],
              }
            },
          )
        },
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'messages',
          filter: `channel_id=eq.${channelId}`,
        },
        (payload) => {
          const parsed = realtimeMessageSchema.safeParse(payload.new)
          if (!parsed.success) {
            logger.error('Malformed realtime message update payload', {
              channelId,
              error: parsed.error.message,
            })
            return
          }

          // WHY: Both soft-deletes and edits are UPDATE events. In both cases
          // we update in-place. For soft-deletes, the message stays in cache
          // with `deletedBy` set so the UI can show "[Message deleted]" or
          // "[Message removed by moderator]" instead of silently disappearing.
          const message = toMessageResponse(parsed.data)
          queryClient.setQueryData<InfiniteData<MessageListResponse>>(
            queryKeys.messages.byChannel(channelId),
            (old) => {
              if (!old) return undefined
              return {
                ...old,
                pages: old.pages.map((page) => ({
                  ...page,
                  items: page.items.map((m) => (m.id === message.id ? message : m)),
                })),
              }
            },
          )
        },
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [channelId, queryClient])
}
