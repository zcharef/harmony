import { useMutation, useQueryClient } from '@tanstack/react-query'
import { sendMessage } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'

/**
 * WHY invalidation on success: Realtime delivers INSERT events but can be
 * unreliable (WebSocket failures, race conditions). Invalidation ensures
 * the user always sees their own message. The deduplication in
 * useFlatMessages (chat-area.tsx) handles the case where both Realtime
 * and invalidation fire.
 */
export function useSendMessage(channelId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (content: string) => {
      const { data } = await sendMessage({
        path: { id: channelId },
        body: { content },
        throwOnError: true,
      })
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.messages.byChannel(channelId) })
    },
  })
}
