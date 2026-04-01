import { useCallback } from 'react'
import { z } from 'zod'
import { useServerEvent } from '@/hooks/use-server-event'
import { logger } from '@/lib/logger'
import { useUnreadStore } from '../stores/unread-store'

/**
 * WHY expanded schema: need message.messageType to filter system messages.
 * System messages (join/leave announcements) should not count as unread — matches Discord.
 */
const unreadEventSchema = z.object({
  channelId: z.string(),
  message: z.object({
    messageType: z.string(),
  }),
})

/** WHY: channel.deleted only carries channelId. */
const channelDeletedSchema = z.object({
  channelId: z.string(),
})

/**
 * Subscribes to SSE events for real-time unread delta updates:
 * - message.created → increment unread for non-active channels
 * - channel.deleted → clean up store entry for the deleted channel
 *
 * Mounted in MainLayout (not ChatArea) so it is ALWAYS active regardless
 * of whether a channel is selected.
 *
 * Sender exclusion is handled server-side (events.rs filters out the
 * sender's own message.created events), so no client-side sender check
 * is needed.
 */
export function useRealtimeUnread(activeChannelId: string | null) {
  const increment = useUnreadStore((s) => s.increment)
  const clear = useUnreadStore((s) => s.clear)

  const handleMessageCreated = useCallback(
    (payload: unknown) => {
      const parsed = unreadEventSchema.safeParse(payload)
      if (!parsed.success) {
        logger.warn('malformed_message_created_for_unread', {
          error: parsed.error.message,
        })
        return
      }

      // WHY: System messages (join/leave) should not count as unread — matches Discord.
      if (parsed.data.message.messageType === 'system') return

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

  // WHY: Clean up store entry when a channel is deleted to prevent stale counts.
  const handleChannelDeleted = useCallback(
    (payload: unknown) => {
      const parsed = channelDeletedSchema.safeParse(payload)
      if (!parsed.success) {
        logger.warn('malformed_channel_deleted_for_unread', { error: parsed.error.message })
        return
      }
      clear(parsed.data.channelId)
    },
    [clear],
  )

  useServerEvent('message.created', handleMessageCreated)
  useServerEvent('channel.deleted', handleChannelDeleted)
}
