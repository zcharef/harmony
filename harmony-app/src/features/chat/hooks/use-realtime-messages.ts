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
 * WHY deduplication: the sendMessage mutation already invalidates the
 * query cache, so the same message could arrive twice (once from the
 * mutation's onSuccess invalidation, once from Realtime). We skip
 * messages that already exist in the cache.
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

          // Transform snake_case DB row to camelCase MessageResponse
          const message: MessageResponse = {
            id: row.id as string,
            channelId: row.channel_id as string,
            authorId: row.author_id as string,
            content: row.content as string,
            createdAt: row.created_at as string,
            editedAt: (row.edited_at as string | null) ?? undefined,
          }

          queryClient.setQueryData<MessageListResponse>(
            queryKeys.messages.byChannel(channelId),
            (old) => {
              if (!old) return undefined

              // Deduplicate: skip if message already exists in cache
              const alreadyExists = old.items.some((m) => m.id === message.id)
              if (alreadyExists) return old

              return { ...old, items: [...old.items, message] }
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
