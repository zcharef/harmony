import type { InfiniteData } from '@tanstack/react-query'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import type { MessageListResponse, MessageResponse } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { supabase } from '@/lib/supabase'

/**
 * Subscribes to Supabase Realtime Postgres Changes for new messages
 * in a given channel, and updates the TanStack Query cache on INSERT.
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
          const row = payload.new as Record<string, unknown>

          // WHY: Transform snake_case DB row to camelCase MessageResponse
          const message: MessageResponse = {
            id: row.id as string,
            channelId: row.channel_id as string,
            authorId: row.author_id as string,
            content: row.content as string,
            createdAt: row.created_at as string,
            editedAt: (row.edited_at as string | null) ?? undefined,
          }

          queryClient.setQueryData<InfiniteData<MessageListResponse>>(
            queryKeys.messages.byChannel(channelId),
            (old) => {
              if (!old) return undefined

              const firstPage = old.pages[0]
              if (!firstPage) return old

              // WHY: Deduplicate — sendMessage mutation invalidation can race with Realtime
              const alreadyExists = firstPage.items.some((m) => m.id === message.id)
              if (alreadyExists) return old

              // WHY: Prepend to page 0 — API returns DESC, so newest items are first
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
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [channelId, queryClient])
}
