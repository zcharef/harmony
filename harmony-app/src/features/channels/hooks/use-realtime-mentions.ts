import { useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { z } from 'zod'
import { useServerEvent } from '@/hooks/use-server-event'
import { logger } from '@/lib/logger'
import { isDmServer } from '../lib/is-dm-server'
import { useUnreadStore } from '../stores/unread-store'

const mentionReceivedSchema = z.object({
  channelId: z.string(),
})

/**
 * WHY mentions is optional: older API instances omit the field during rollout
 * (same convention as event-types.ts messagePayloadSchema.mentions).
 */
const dmMessageSchema = z.object({
  serverId: z.string(),
  channelId: z.string(),
  message: z.object({
    messageType: z.string(),
    mentions: z.array(z.object({ userId: z.string() })).optional(),
  }),
})

/** WHY: channel.deleted only carries channelId. */
const channelDeletedSchema = z.object({
  channelId: z.string(),
})

/**
 * Subscribes to SSE events for real-time mention badge deltas, implementing
 * mention-equivalence (spec §1) with two DISJOINT increment rules — no double
 * count by construction:
 *
 * 1. `mention.received` (targeted, delivered only to the mentioned user) →
 *    increment. Covers explicit `<@uuid>` markers everywhere, including DMs.
 * 2. `message.created` in a DM server WITHOUT the current user in `mentions` →
 *    increment. Covers plain DM messages (every DM message pings — Discord
 *    model); explicit DM markers are already counted by rule 1.
 *
 * Sender exclusion is server-side on both paths (the author is stripped from
 * the mention list; message.created excludes the sender), so no client-side
 * sender check is needed.
 *
 * Mounted in MainLayout next to useRealtimeUnread (global-listener rule §4.6).
 * Modeled on use-realtime-unread.ts.
 */
export function useRealtimeMentions(activeChannelId: string | null, userId: string | null): void {
  const queryClient = useQueryClient()
  const incrementMention = useUnreadStore((s) => s.incrementMention)
  const clear = useUnreadStore((s) => s.clear)

  const handleMentionReceived = useCallback(
    (payload: unknown) => {
      const parsed = mentionReceivedSchema.safeParse(payload)
      if (!parsed.success) {
        logger.warn('malformed_mention_received_event', { error: parsed.error.message })
        return
      }

      // WHY: Don't increment for the channel the user is currently viewing —
      // they see the message in real-time, and useMarkReadOnFocus will mark
      // it as read immediately (same rule as unreads).
      if (parsed.data.channelId !== activeChannelId) {
        incrementMention(parsed.data.channelId)
      }
    },
    [activeChannelId, incrementMention],
  )

  const handleMessageCreated = useCallback(
    (payload: unknown) => {
      if (userId === null) return

      const parsed = dmMessageSchema.safeParse(payload)
      if (!parsed.success) {
        logger.warn('malformed_message_created_for_mentions', { error: parsed.error.message })
        return
      }

      const { serverId, channelId, message } = parsed.data

      // WHY: System messages never count (mirrors the unread + server-side rule).
      if (message.messageType === 'system') return
      // WHY: Rule 2 applies to DM servers only — non-DM mentions ride rule 1.
      if (isDmServer(serverId, queryClient) === false) return
      // WHY disjointness: an explicit DM marker targeting me already published
      // a mention.received (rule 1). Counting it here would double-count.
      const mentionsMe = (message.mentions ?? []).some((m) => m.userId === userId)
      if (mentionsMe === true) return
      if (channelId === activeChannelId) return

      incrementMention(channelId)
    },
    [activeChannelId, userId, queryClient, incrementMention],
  )

  // WHY: Clean up store entries when a channel is deleted to prevent stale counts.
  const handleChannelDeleted = useCallback(
    (payload: unknown) => {
      const parsed = channelDeletedSchema.safeParse(payload)
      if (!parsed.success) {
        logger.warn('malformed_channel_deleted_for_mentions', { error: parsed.error.message })
        return
      }
      clear(parsed.data.channelId)
    },
    [clear],
  )

  useServerEvent('mention.received', handleMentionReceived)
  useServerEvent('message.created', handleMessageCreated)
  useServerEvent('channel.deleted', handleChannelDeleted)
}
