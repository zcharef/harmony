import { useMutation, useQueryClient } from '@tanstack/react-query'
import { sendMessage } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'

/**
 * WHY: Wraps sendMessage SDK in a mutation with automatic cache
 * invalidation so the message list refreshes after sending.
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
      queryClient.invalidateQueries({
        queryKey: queryKeys.messages.byChannel(channelId),
      })
    },
  })
}
