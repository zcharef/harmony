import type { InfiniteData } from '@tanstack/react-query'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { z } from 'zod'
import { useServerEvent } from '@/hooks/use-server-event'
import type { MessageListResponse, PinnedMessagesResponse } from '@/lib/api'
import { messagePayloadSchema } from '@/lib/event-types'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'
import { patchMessagePinned, prependPin, removePin } from './pins-cache'
import { toMessageResponse } from './use-realtime-messages'

/** message.pinned carries the full message so the panel renders with no refetch. */
const pinnedSchema = z.object({ channelId: z.string(), message: messagePayloadSchema })
/** message.unpinned carries only the id — the panel drops it. */
const unpinnedSchema = z.object({ channelId: z.string(), messageId: z.string() })
/** message.deleted — a pinned message being deleted must drop from the panel. */
const deletedSchema = z.object({ channelId: z.string(), messageId: z.string() })

/**
 * Keeps the pins panel + the inline pinned flag live via SSE. Patches both the
 * pins-list cache and the message cache with `setQueryData` (never invalidate,
 * standing order). Mounted per active channel, like `useRealtimeMessages`.
 */
export function useRealtimePins(channelId: string) {
  const queryClient = useQueryClient()

  const handlePinned = useCallback(
    (payload: unknown) => {
      const parsed = pinnedSchema.safeParse(payload)
      if (!parsed.success) {
        logger.error('Malformed message.pinned SSE payload', { error: parsed.error.message })
        return
      }
      const message = toMessageResponse(parsed.data.message)
      queryClient.setQueryData<PinnedMessagesResponse>(
        queryKeys.pins.byChannel(parsed.data.channelId),
        (old) => prependPin(old, message),
      )
      queryClient.setQueryData<InfiniteData<MessageListResponse>>(
        queryKeys.messages.byChannel(parsed.data.channelId),
        (old) => patchMessagePinned(old, message.id, true),
      )
    },
    [queryClient],
  )

  const handleUnpinned = useCallback(
    (payload: unknown) => {
      const parsed = unpinnedSchema.safeParse(payload)
      if (!parsed.success) {
        logger.error('Malformed message.unpinned SSE payload', { error: parsed.error.message })
        return
      }
      queryClient.setQueryData<PinnedMessagesResponse>(
        queryKeys.pins.byChannel(parsed.data.channelId),
        (old) => removePin(old, parsed.data.messageId),
      )
      queryClient.setQueryData<InfiniteData<MessageListResponse>>(
        queryKeys.messages.byChannel(parsed.data.channelId),
        (old) => patchMessagePinned(old, parsed.data.messageId, false),
      )
    },
    [queryClient],
  )

  const handleDeleted = useCallback(
    (payload: unknown) => {
      const parsed = deletedSchema.safeParse(payload)
      if (!parsed.success) return
      // WHY: a deleted message that was pinned must leave the panel (no orphan
      // pin, spec §6). The message cache is handled by useRealtimeMessages.
      queryClient.setQueryData<PinnedMessagesResponse>(
        queryKeys.pins.byChannel(parsed.data.channelId),
        (old) => removePin(old, parsed.data.messageId),
      )
    },
    [queryClient],
  )

  useServerEvent(channelId.length > 0 ? 'message.pinned' : null, handlePinned)
  useServerEvent(channelId.length > 0 ? 'message.unpinned' : null, handleUnpinned)
  useServerEvent(channelId.length > 0 ? 'message.deleted' : null, handleDeleted)
}
