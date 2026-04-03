import type { InfiniteData } from '@tanstack/react-query'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import i18n from 'i18next'
import type { DmListItem, MessageListResponse, MessageResponse } from '@/lib/api'
import { sendMessage } from '@/lib/api'
import { getApiErrorDetail, isProblemDetails } from '@/lib/api-error'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'
import { toast } from '@/lib/toast'
import { buildParentPreview } from './build-parent-preview'

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
  username: string,
  encryption?: SendMessageEncryption,
  /** WHY: Called with remaining seconds when the server returns 429 (slow mode).
   * Allows ChatArea to sync the client-side countdown timer with server state. */
  onRateLimited?: (remainingSeconds: number) => void,
) {
  const queryClient = useQueryClient()
  const messageQueryKey = queryKeys.messages.byChannel(channelId)

  return useMutation({
    mutationFn: async (input: { content: string; parentMessageId?: string }) => {
      // WHY: Attempt encryption if available. encryptFn is wrapped in its own
      // try/catch so that encryption failures (e.g. recipient has no E2EE keys →
      // 404 from getPreKeyBundle) fall back to plaintext instead of killing the
      // entire mutation. sendMessage is called outside this catch so API errors
      // propagate to onError as expected.
      if (encryption !== undefined) {
        let encrypted: { content: string; senderDeviceId: string } | null = null
        try {
          encrypted = await encryption.encryptFn(input.content)
        } catch (encryptionError) {
          // WHY: Graceful degradation — matches web DM behavior (always plaintext).
          // The lock icon in MessageHeader already signals encrypted vs plaintext.
          logger.warn('dm_encryption_failed_fallback_plaintext', {
            channelId,
            error:
              encryptionError instanceof Error ? encryptionError.message : String(encryptionError),
          })
        }

        if (encrypted !== null) {
          const { data } = await sendMessage({
            path: { id: channelId },
            body: {
              content: encrypted.content,
              encrypted: true,
              senderDeviceId: encrypted.senderDeviceId,
              parentMessageId: input.parentMessageId,
            },
            throwOnError: true,
          })
          // WHY: Cache the plaintext locally so the sender can read their own message
          // without needing to decrypt it (sender doesn't have their own session).
          encryption.cachePlaintext(data.id, channelId, input.content)
          return data
        }
      }

      const { data } = await sendMessage({
        path: { id: channelId },
        body: { content: input.content, parentMessageId: input.parentMessageId },
        throwOnError: true,
      })
      return data
    },

    onMutate: async (input: { content: string; parentMessageId?: string }) => {
      // WHY cancel: Prevent in-flight refetches from overwriting our optimistic entry
      await queryClient.cancelQueries({ queryKey: messageQueryKey })

      const previousData =
        queryClient.getQueryData<InfiniteData<MessageListResponse>>(messageQueryKey)

      const optimisticId = `temp-${crypto.randomUUID()}`

      // WHY: Build parentMessage preview from cached messages so the ParentQuote
      // renders immediately in the optimistic entry, not only after invalidation.
      const parentMessage =
        input.parentMessageId !== undefined && previousData !== undefined
          ? buildParentPreview(previousData, input.parentMessageId)
          : undefined

      const optimisticMessage = {
        id: optimisticId,
        channelId: channelId,
        authorId: userId,
        authorUsername: username,
        // WHY: Show plaintext in optimistic entry so user sees their message immediately.
        // The encrypted version is what goes to the API, not what displays.
        // WHY encrypted: false: The optimistic message contains plaintext. Setting
        // encrypted: true would route it through EncryptedMessageContent, which tries
        // to JSON.parse the plaintext as an Olm envelope and fails with "Could not decrypt".
        content: input.content,
        createdAt: new Date().toISOString(),
        encrypted: false,
        messageType: 'default',
        reactions: [],
        parentMessageId: input.parentMessageId,
        parentMessage,
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

      // WHY: The backend excludes the sender from message.created SSE events
      // (optimistic UI handles the chat area). But the DM sidebar preview
      // never receives the update. This updates lastMessage + reorders the
      // list for the sender. No-op if channelId doesn't match any DM.
      queryClient.setQueryData<DmListItem[]>(queryKeys.dms.list(), (old) => {
        if (!old) return undefined

        const idx = old.findIndex((dm) => dm.channelId === channelId)
        const match = old[idx]
        if (idx === -1 || !match) return old

        const updated: DmListItem = {
          ...match,
          lastMessage: {
            content: realMessage.content,
            createdAt: realMessage.createdAt,
            encrypted: realMessage.encrypted,
          },
        }
        return [updated, ...old.slice(0, idx), ...old.slice(idx + 1)]
      })
    },

    onError: (error, _input, context) => {
      logger.error('Failed to send message', {
        channelId,
        error: error instanceof Error ? error.message : String(error),
      })
      // WHY: 429 = slow mode. Sync client countdown from server's remaining time,
      // and always show toast (essential post-refresh when client has no countdown).
      if (isProblemDetails(error) && error.status === 429) {
        const waitMatch = error.detail.match(/wait (\d+) second/)
        if (waitMatch !== null && onRateLimited !== undefined) {
          onRateLimited(Number(waitMatch[1]))
        }
      }
      toast.error(getApiErrorDetail(error, i18n.t('chat:sendMessageFailed')))

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
