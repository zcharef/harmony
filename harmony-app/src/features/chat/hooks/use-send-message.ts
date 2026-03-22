import type { InfiniteData } from '@tanstack/react-query'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { MessageListResponse, MessageResponse } from '@/lib/api'
import { sendMessage } from '@/lib/api'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'

export interface SendMessageEncryption {
  /** WHY: Async function that encrypts plaintext and returns the ciphertext envelope + deviceId. */
  encryptFn: (plaintext: string) => Promise<{ content: string; senderDeviceId: string }>
  /** WHY: Callback to cache the plaintext locally after successful send. */
  cachePlaintext: (messageId: string, channelId: string, plaintext: string) => void
}

/**
 * WHY optimistic updates: The user sees their message instantly in the list
 * instead of waiting for the API round-trip + Realtime echo. On success, the
 * temp message is swapped for the real one (prevents duplicate with Realtime).
 * On error, the cache is rolled back to the snapshot taken before the mutation.
 *
 * WHY optional encryption param: When `encryption` is provided (DM on desktop),
 * the hook encrypts content before sending and caches the plaintext locally.
 * When absent (channels or web), it sends plaintext as before. This keeps the
 * hook signature backward-compatible — no changes needed for channel message sending.
 */
export function useSendMessage(
  channelId: string,
  userId: string,
  encryption?: SendMessageEncryption,
) {
  const queryClient = useQueryClient()
  const messageQueryKey = queryKeys.messages.byChannel(channelId)

  return useMutation({
    mutationFn: async (content: string) => {
      // WHY: If encryption is provided, encrypt before sending to API.
      if (encryption !== undefined) {
        const encrypted = await encryption.encryptFn(content)
        const { data } = await sendMessage({
          path: { id: channelId },
          body: {
            content: encrypted.content,
            encrypted: true,
            senderDeviceId: encrypted.senderDeviceId,
          },
          throwOnError: true,
        })
        // WHY: Cache the plaintext locally so the sender can read their own message
        // without needing to decrypt it (sender doesn't have their own session).
        encryption.cachePlaintext(data.id, channelId, content)
        return data
      }

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
        // WHY: Show plaintext in optimistic entry so user sees their message immediately.
        // The encrypted version is what goes to the API, not what displays.
        content: content,
        createdAt: new Date().toISOString(),
        encrypted: encryption !== undefined,
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
