import type { InfiniteData } from '@tanstack/react-query'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { z } from 'zod'
import { useServerEvent } from '@/hooks/use-server-event'
import type { MessageListResponse, MessageResponse } from '@/lib/api'
import { messagePayloadSchema } from '@/lib/event-types'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'
import { buildParentPreview } from './build-parent-preview'

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
 * WHY: Maps SSE MessagePayload to the REST MessageResponse shape for cache insertion.
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
    parentMessageId: payload.parentMessageId ?? undefined,
    createdAt: payload.createdAt,
    messageType: payload.messageType,
    systemEventKey: payload.systemEventKey ?? undefined,
    moderatedAt: payload.moderatedAt ?? undefined,
    moderationReason: payload.moderationReason ?? undefined,
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

      const eventChannelId = parsed.data.channelId

      // WHY: Update the cache for whichever channel this message belongs to
      // (active or inactive). For inactive channels, the cache may not exist
      // (gcTime expired) — the `if (!old) return undefined` guard handles that.
      // Using setQueryData (not invalidateQueries) per CLAUDE.md §4.5.
      const message = toMessageResponse(parsed.data.message)

      queryClient.setQueryData<InfiniteData<MessageListResponse>>(
        queryKeys.messages.byChannel(eventChannelId),
        (old) => {
          if (!old) return undefined

          const firstPage = old.pages[0]
          if (!firstPage) return old

          // WHY: Deduplicate — useFlatMessages also dedupes, but skipping
          // the cache update entirely is cheaper than inserting then filtering.
          const alreadyExists = firstPage.items.some((m) => m.id === message.id)
          if (alreadyExists) return old

          // WHY: Build parentMessage from cache so ParentQuote renders immediately.
          // Falls back to undefined if parent was garbage-collected (next REST fetch fixes it).
          const enriched =
            message.parentMessageId !== undefined && message.parentMessageId !== null
              ? { ...message, parentMessage: buildParentPreview(old, message.parentMessageId) }
              : message

          return {
            ...old,
            pages: [{ ...firstPage, items: [enriched, ...firstPage.items] }, ...old.pages.slice(1)],
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

      const message = toMessageResponse(parsed.data.message)

      queryClient.setQueryData<InfiniteData<MessageListResponse>>(
        queryKeys.messages.byChannel(parsed.data.channelId),
        (old) => {
          if (!old) return undefined
          return {
            ...old,
            pages: old.pages.map((page) => ({
              ...page,
              items: page.items.map((m) => {
                if (m.id !== message.id) return m
                // WHY: Preserve the existing parentMessage from the cache entry.
                // The SSE update payload doesn't carry it, so re-use what was
                // already resolved (from REST or from a prior buildParentPreview).
                return { ...message, parentMessage: m.parentMessage }
              }),
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

      // WHY: Soft-delete — set deletedBy to signal the UI to show
      // "[Message deleted]" instead of silently removing the message.
      // The SSE message.deleted event doesn't carry who deleted it,
      // so we use a sentinel value. The REST API will have the real
      // deletedBy on next full fetch.
      // Also marks parentMessage as deleted on child messages that
      // quote the deleted message, so the quote shows "[deleted]".
      queryClient.setQueryData<InfiniteData<MessageListResponse>>(
        queryKeys.messages.byChannel(parsed.data.channelId),
        (old) => {
          if (!old) return undefined
          return {
            ...old,
            pages: old.pages.map((page) => ({
              ...page,
              items: page.items.map((m) => {
                if (m.id === parsed.data.messageId) {
                  return { ...m, deletedBy: m.authorId }
                }
                if (m.parentMessage?.id === parsed.data.messageId) {
                  return {
                    ...m,
                    parentMessage: {
                      ...m.parentMessage,
                      deleted: true,
                      contentPreview: '',
                      authorUsername: '',
                    },
                  }
                }
                return m
              }),
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
