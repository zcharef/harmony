import { useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { z } from 'zod'
import { useServerEvent } from '@/hooks/use-server-event'
import type { DmListItem } from '@/lib/api'
import { messagePayloadSchema } from '@/lib/event-types'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'

/** WHY: message.created carries channelId + full message — we only need content + createdAt for the preview. */
const messageEventSchema = z.object({
  channelId: z.string(),
  message: messagePayloadSchema.pick({ content: true, createdAt: true }),
})

/**
 * Subscribes to SSE events that affect the DM sidebar list:
 *
 * - dm.created: invalidates the DM list (new conversation needs full refetch
 *   because the SSE payload shape differs from DmListItem).
 * - message.created: updates `lastMessage` preview and reorders the list so
 *   the most recently active DM floats to the top.
 *
 * WHY no requestReconnect: The backend SSE handler (events.rs) dynamically
 * updates the server_ids filter via a tokio::sync::watch channel when a
 * DmCreated event is intercepted. No client-side reconnect needed.
 */
export function useRealtimeDms() {
  const queryClient = useQueryClient()

  const handleDmCreated = useCallback(
    (payload: unknown) => {
      logger.info('dm.created SSE event received, invalidating DM list cache', {
        hasPayload: payload !== null && payload !== undefined,
      })

      queryClient.invalidateQueries({ queryKey: queryKeys.dms.list() })
    },
    [queryClient],
  )

  const handleMessageCreated = useCallback(
    (payload: unknown) => {
      const parsed = messageEventSchema.safeParse(payload)
      if (!parsed.success) {
        logger.warn('dm_message_event_parse_failed', { error: parsed.error.message })
        return
      }

      const { channelId, message } = parsed.data

      queryClient.setQueryData<DmListItem[]>(queryKeys.dms.list(), (old) => {
        if (!old) return undefined

        const idx = old.findIndex((dm) => dm.channelId === channelId)
        const match = old[idx]
        // WHY: If channelId doesn't match any DM, it's a regular channel message — skip.
        if (idx === -1 || !match) return old

        const updated: DmListItem = {
          ...match,
          lastMessage: { content: message.content, createdAt: message.createdAt },
        }

        // WHY: Move the updated DM to position 0 so the sidebar reflects
        // most-recent-activity ordering without a full refetch.
        return [updated, ...old.slice(0, idx), ...old.slice(idx + 1)]
      })
    },
    [queryClient],
  )

  useServerEvent('dm.created', handleDmCreated)
  useServerEvent('message.created', handleMessageCreated)
}
