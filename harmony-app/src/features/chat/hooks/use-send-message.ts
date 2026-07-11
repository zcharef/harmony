import type { InfiniteData } from '@tanstack/react-query'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import i18n from 'i18next'
import type {
  AttachmentResponse,
  DmListItem,
  MentionedUserResponse,
  MessageListResponse,
  MessageResponse,
  NewAttachmentRequest,
  ProfileResponse,
} from '@/lib/api'
import { sendMessage } from '@/lib/api'
import { getApiErrorDetail, isProblemDetails } from '@/lib/api-error'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'
import { toast } from '@/lib/toast'
import { OPTIMISTIC_ID_PREFIX } from '../lib/optimistic-id'
import { buildParentPreview } from './build-parent-preview'

// WHY re-exported: existing consumers import this from the send hook; the SSoT
// now lives in the React-free lib/optimistic-id module.
export { OPTIMISTIC_ID_PREFIX }

export interface SendMessageInput {
  /** Content AFTER the mention transform — `<@uuid>` markers already applied. */
  content: string
  parentMessageId?: string
  /**
   * Mentioned users resolved by the composer's map (spec §5.2). Drives the
   * optimistic message's pills for both paths; only the ENCRYPTED request
   * carries the ids (plaintext is re-parsed server-side, authoritatively).
   */
  mentions?: MentionedUserResponse[]
  /**
   * Files already uploaded to the `attachments` bucket by the composer tray
   * (spec §5.2). The key is OMITTED entirely when empty — never [] or null
   * (minimizes the deny_unknown_fields version-skew surface, §8). Plaintext
   * channels only; the composer hides attach UI in encrypted contexts (D7).
   */
  attachments?: NewAttachmentRequest[]
}

/**
 * Builds an optimistic `AttachmentResponse` from the uploaded metadata so the
 * sender's own images render instantly; the server echo swaps in the real row
 * (with its authoritative AttachmentId) on success.
 */
function toOptimisticAttachment(attachment: NewAttachmentRequest): AttachmentResponse {
  return {
    id: `${OPTIMISTIC_ID_PREFIX}${crypto.randomUUID()}`,
    url: attachment.url,
    mime: attachment.mime,
    size: attachment.size,
    ...(attachment.width !== undefined && attachment.width !== null
      ? { width: attachment.width }
      : {}),
    ...(attachment.height !== undefined && attachment.height !== null
      ? { height: attachment.height }
      : {}),
    // The sender's own echo starts blurred/pending like every reader's, then
    // flips when the scan verdict arrives via message.updated.
    moderationStatus: 'pending',
  }
}

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
    mutationFn: async (input: SendMessageInput) => {
      // WHY encrypted context is fail-closed: When `encryption` is present the user
      // believes this DM is end-to-end encrypted. If encryptFn fails (recipient has
      // no pre-key bundle → 404, Olm/ratchet error, Tauri invoke failure) we MUST NOT
      // silently send the content in cleartext — that is a confidentiality downgrade
      // the user never consented to and stores their message plaintext server-side.
      // We reject the mutation instead so onError surfaces visible feedback and
      // nothing is sent. sendMessage is called outside the catch so genuine API
      // errors still propagate to onError as expected.
      if (encryption !== undefined) {
        let encrypted: { content: string; senderDeviceId: string }
        try {
          encrypted = await encryption.encryptFn(input.content)
        } catch (encryptionError) {
          logger.warn('dm_encryption_failed_message_not_sent', {
            channelId,
            error:
              encryptionError instanceof Error ? encryptionError.message : String(encryptionError),
          })
          throw new Error(
            'Message not sent — could not encrypt it. Your recipient may not have encryption set up.',
          )
        }

        // WHY only here: the server cannot parse ciphertext, so the encrypted
        // path carries the plaintext sidecar (parsed client-side PRE-encryption).
        // The key is OMITTED entirely when empty — never [] or null (spec §3.1;
        // minimizes the deny_unknown_fields version-skew surface, §8).
        const mentionedUserIds = (input.mentions ?? []).map((m) => m.userId)
        const attachments = input.attachments ?? []
        const { data } = await sendMessage({
          path: { id: channelId },
          body: {
            content: encrypted.content,
            encrypted: true,
            senderDeviceId: encrypted.senderDeviceId,
            parentMessageId: input.parentMessageId,
            ...(mentionedUserIds.length > 0 ? { mentionedUserIds } : {}),
            ...(attachments.length > 0 ? { attachments } : {}),
          },
          throwOnError: true,
        })
        // WHY: Cache the plaintext locally so the sender can read their own message
        // without needing to decrypt it (sender doesn't have their own session).
        encryption.cachePlaintext(data.id, channelId, input.content)
        return data
      }

      // WHY plaintext here is intentional: no encryption context means a channel
      // message or a web DM (plaintext by design). No mention field either —
      // the server parses `<@uuid>` markers itself, authoritatively (spec §3.1).
      const attachments = input.attachments ?? []
      const { data } = await sendMessage({
        path: { id: channelId },
        body: {
          content: input.content,
          parentMessageId: input.parentMessageId,
          ...(attachments.length > 0 ? { attachments } : {}),
        },
        throwOnError: true,
      })
      return data
    },

    onMutate: async (input: SendMessageInput) => {
      // WHY cancel: Prevent in-flight refetches from overwriting our optimistic entry
      await queryClient.cancelQueries({ queryKey: messageQueryKey })

      const previousData =
        queryClient.getQueryData<InfiniteData<MessageListResponse>>(messageQueryKey)

      const optimisticId = `${OPTIMISTIC_ID_PREFIX}${crypto.randomUUID()}`

      // WHY: Seed the optimistic row with the sender's display name + avatar from
      // the profile cache (SSoT) so their own message renders identically to the
      // server echo — no username/initials flash before onSuccess swaps in the
      // real message. Absent cache (cold start) falls back to null → username.
      const selfProfile = queryClient.getQueryData<ProfileResponse>(queryKeys.profiles.me())

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
        authorDisplayName: selfProfile?.displayName ?? null,
        authorAvatarUrl: selfProfile?.avatarUrl ?? null,
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
        // WHY: Seed from the composer's mention map so the sender's own pills
        // render instantly (spec §5.2); the server echo swaps in the
        // authoritative (validated, access-gated) list on success.
        mentions: input.mentions ?? [],
        // WHY seed from the uploaded metadata: the sender's own images render
        // instantly (temp AttachmentIds); the server echo swaps in the real
        // rows on success (REACTIVITY — no refresh, spec §5.2).
        attachments: (input.attachments ?? []).map(toOptimisticAttachment),
        // WHY empty: link previews unfurl asynchronously server-side; they
        // arrive via message.updated after the echo (never optimistic).
        embeds: [],
        // WHY false: a freshly-sent message is never pinned. The flag keeps the
        // optimistic entry shape-compatible with the server echo.
        isPinned: false,
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
