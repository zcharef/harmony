import type { InfiniteData } from '@tanstack/react-query'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { z } from 'zod'
import { useUnreadStore } from '@/features/channels'
import { useServerEvent } from '@/hooks/use-server-event'
import type { MessageListResponse, MessageResponse } from '@/lib/api'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'

/**
 * WHY local schema (not imported from event-types.ts): useEventSource already
 * validates the full discriminated union via serverEventSchema. This local schema
 * validates only the subset of fields needed for cache mutation (no `type`,
 * `senderId`, etc.), and maps them to MessageResponse via toMessageResponse().
 * Keeping it local makes the handler self-contained and avoids coupling to the
 * full event shape.
 */
const messagePayloadSchema = z.object({
  id: z.string(),
  channelId: z.string(),
  content: z.string(),
  authorId: z.string(),
  authorUsername: z.string(),
  authorAvatarUrl: z.string().nullable(),
  encrypted: z.boolean(),
  senderDeviceId: z.string().nullable(),
  editedAt: z.string().nullable(),
  createdAt: z.string(),
})

/** WHY: message.created and message.updated carry the full message payload. */
const messageEventSchema = z.object({
  channelId: z.string(),
  message: messagePayloadSchema,
})

/** WHY: message.deleted only carries messageId + channelId, not the full message. */
const messageDeletedSchema = z.object({
  channelId: z.string(),
  messageId: z.string(),
})

/**
 * WHY: The SSE MessagePayload is a subset of the REST MessageResponse.
 * The SSE payload lacks `messageType` and `systemEventKey` because the Rust
 * ServerEvent::MessagePayload struct doesn't include them. We default to
 * 'default' for messageType — system messages are rare and will get the
 * correct type on the next full fetch.
 */
function toMessageResponse(payload: z.infer<typeof messagePayloadSchema>): MessageResponse {
  return {
    id: payload.id,
    channelId: payload.channelId,
    content: payload.content,
    authorId: payload.authorId,
    authorUsername: payload.authorUsername,
    authorAvatarUrl: payload.authorAvatarUrl,
    encrypted: payload.encrypted,
    senderDeviceId: payload.senderDeviceId,
    editedAt: payload.editedAt,
    createdAt: payload.createdAt,
    messageType: 'default',
    reactions: [],
  }
}

/**
 * Subscribes to SSE message events for a given channel and updates
 * the TanStack Query cache on:
 * - message.created: new message prepended to page 0
 * - message.updated: message replaced in-place across all pages
 * - message.deleted: message soft-deleted in-place (deletedBy set)
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

  const handleMessageCreated = useCallback(
    (payload: unknown) => {
      if (channelId.length === 0) return

      const parsed = messageEventSchema.safeParse(payload)
      if (!parsed.success) {
        logger.error('Malformed message.created SSE payload', {
          channelId,
          error: parsed.error.message,
        })
        return
      }

      // WHY: Increment unread count for channels other than the one being viewed.
      // This ensures the sidebar badge updates in real-time via SSE.
      if (parsed.data.channelId !== channelId) {
        useUnreadStore.getState().increment(parsed.data.channelId)
        return
      }

      const message = toMessageResponse(parsed.data.message)

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
            pages: [{ ...firstPage, items: [message, ...firstPage.items] }, ...old.pages.slice(1)],
          }
        },
      )
    },
    [channelId, queryClient],
  )

  const handleMessageUpdated = useCallback(
    (payload: unknown) => {
      if (channelId.length === 0) return

      const parsed = messageEventSchema.safeParse(payload)
      if (!parsed.success) {
        logger.error('Malformed message.updated SSE payload', {
          channelId,
          error: parsed.error.message,
        })
        return
      }

      if (parsed.data.channelId !== channelId) return

      const message = toMessageResponse(parsed.data.message)

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
    [channelId, queryClient],
  )

  const handleMessageDeleted = useCallback(
    (payload: unknown) => {
      if (channelId.length === 0) return

      const parsed = messageDeletedSchema.safeParse(payload)
      if (!parsed.success) {
        logger.error('Malformed message.deleted SSE payload', {
          channelId,
          error: parsed.error.message,
        })
        return
      }

      if (parsed.data.channelId !== channelId) return

      // WHY: Soft-delete — set deletedBy to signal the UI to show
      // "[Message deleted]" instead of silently removing the message.
      // The SSE message.deleted event doesn't carry who deleted it,
      // so we use a sentinel value. The REST API will have the real
      // deletedBy on next full fetch.
      queryClient.setQueryData<InfiniteData<MessageListResponse>>(
        queryKeys.messages.byChannel(channelId),
        (old) => {
          if (!old) return undefined
          return {
            ...old,
            pages: old.pages.map((page) => ({
              ...page,
              items: page.items.map((m) =>
                m.id === parsed.data.messageId ? { ...m, deletedBy: m.authorId } : m,
              ),
            })),
          }
        },
      )
    },
    [channelId, queryClient],
  )

  useServerEvent(channelId.length > 0 ? 'message.created' : null, handleMessageCreated)
  useServerEvent(channelId.length > 0 ? 'message.updated' : null, handleMessageUpdated)
  useServerEvent(channelId.length > 0 ? 'message.deleted' : null, handleMessageDeleted)
}
