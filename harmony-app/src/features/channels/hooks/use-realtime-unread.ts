import { useCallback } from 'react'
import { z } from 'zod'
import { useServerEvent } from '@/hooks/use-server-event'
import { logger } from '@/lib/logger'
import { useUnreadStore } from '../stores/unread-store'

/**
 * WHY: Minimal schema — only the fields needed for unread incrementing.
 * The full ServerEvent is already validated by useFetchSSE; this just
 * narrows the shape for safe field access.
 */
const unreadEventSchema = z.object({
  channelId: z.string(),
})

/**
 * WHY: Subscribes to message.created SSE events and increments the unread
 * store for channels other than the one the user is currently viewing.
 *
 * Mounted in MainLayout (not ChatArea) so it is ALWAYS active regardless
 * of whether a channel is selected. Without this, users in DM view with
 * no conversation selected would miss all unread increments — the previous
 * approach coupled incrementing to useRealtimeMessages(channelId) which
 * only subscribes when channelId is non-empty.
 *
 * Sender exclusion is handled server-side (events.rs filters out the
 * sender's own message.created events), so no client-side sender check
 * is needed.
 */
export function useRealtimeUnread(activeChannelId: string | null) {
  const increment = useUnreadStore((s) => s.increment)

  const handler = useCallback(
    (payload: unknown) => {
      const parsed = unreadEventSchema.safeParse(payload)
      if (!parsed.success) {
        logger.error('Malformed message.created payload for unread', {
          error: parsed.error.message,
        })
        return
      }

      const eventChannelId = parsed.data.channelId

      // WHY: Don't increment for the channel the user is currently viewing —
      // they see the message in real-time, and useMarkReadOnFocus will mark
      // it as read immediately.
      if (eventChannelId !== activeChannelId) {
        increment(eventChannelId)
      }
    },
    [activeChannelId, increment],
  )

  useServerEvent('message.created', handler)
}
