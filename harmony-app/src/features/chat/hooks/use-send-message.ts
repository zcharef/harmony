import type { InfiniteData } from '@tanstack/react-query'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { MessageListResponse, MessageResponse } from '@/lib/api'
import { sendMessage } from '@/lib/api'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'

/**
 * WHY optimistic updates: The user sees their message instantly in the list
 * instead of waiting for the API round-trip + Realtime echo. On success, the
 * temp message is swapped for the real one (prevents duplicate with Realtime).
 * On error, the cache is rolled back to the snapshot taken before the mutation.
 */
export function useSendMessage(channelId: string, userId: string) {
  const queryClient = useQueryClient()
  const messageQueryKey = queryKeys.messages.byChannel(channelId)

  return useMutation({
    mutationFn: async (content: string) => {
      const { data } = await sendMessage({
        path: { id: channelId },
        body: { content },
        throwOnError: true,
      })
      return data
    },

    onMutate: async (content) => {
      // WHY cancel: Prevent in-flight refetches from overwriting our optimistic entry
      await queryClient.cancelQueries({ queryKey: messageQueryKey })

      const previousData =
        queryClient.getQueryData<InfiniteData<MessageListResponse>>(messageQueryKey)

      const optimisticId = `temp-${crypto.randomUUID()}`

      const optimisticMessage = {
        id: optimisticId,
        channelId: channelId,
        authorId: userId,
        content: content,
        createdAt: new Date().toISOString(),
      } satisfies MessageResponse

      // WHY page 0: useInfiniteQuery stores pages newest-first — same pattern
      // as use-realtime-messages.ts:82-103
      queryClient.setQueryData<InfiniteData<MessageListResponse>>(messageQueryKey, (old) => {
        if (!old) return undefined

        const firstPage = old.pages[0]
        if (!firstPage) return old

        return {
          ...old,
          pages: [
            { ...firstPage, items: [optimisticMessage, ...firstPage.items] },
            ...old.pages.slice(1),
          ],
        }
      })

      return { previousData, optimisticId }
    },

    onSuccess: (realMessage, _content, context) => {
      if (!context) return

      // WHY replace instead of append: Realtime will also deliver this message
      // via INSERT event. Swapping temp→real by ID prevents a brief duplicate.
      queryClient.setQueryData<InfiniteData<MessageListResponse>>(messageQueryKey, (old) => {
        if (!old) return undefined

        return {
          ...old,
          pages: old.pages.map((page) => ({
            ...page,
            items: page.items.map((m) => (m.id === context.optimisticId ? realMessage : m)),
          })),
        }
      })
    },

    onError: (error, _content, context) => {
      logger.error('Failed to send message', {
        channelId,
        error: error instanceof Error ? error.message : String(error),
      })

      // WHY rollback: Restore the exact cache state from before the mutation
      // so the user does not see a ghost message that never reached the server
      if (context?.previousData) {
        queryClient.setQueryData(messageQueryKey, context.previousData)
      }
    },

    onSettled: () => {
      // WHY invalidate: Ensures cache is eventually consistent regardless of
      // whether the optimistic swap or Realtime delivery worked correctly
      queryClient.invalidateQueries({ queryKey: messageQueryKey })
    },
  })
}
