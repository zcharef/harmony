import { useMutation } from '@tanstack/react-query'
import { sendMessage } from '@/lib/api'

/**
 * WHY no invalidation: Supabase Realtime delivers the INSERT event to
 * useRealtimeMessages, which updates the cache directly. Invalidation
 * would trigger a redundant full refetch of all pages AND race with
 * the realtime event, producing duplicate messages.
 *
 * The deduplication in useFlatMessages (chat-area.tsx) is a safety net,
 * but avoiding the race entirely is better.
 */
export function useSendMessage(channelId: string) {
  return useMutation({
    mutationFn: async (content: string) => {
      const { data } = await sendMessage({
        path: { id: channelId },
        body: { content },
        throwOnError: true,
      })
      return data
    },
  })
}
