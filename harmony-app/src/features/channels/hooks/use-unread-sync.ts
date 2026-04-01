import { useCallback } from 'react'
import { z } from 'zod'
import { useServerEvent } from '@/hooks/use-server-event'
import { logger } from '@/lib/logger'
import { useUnreadStore } from '../stores/unread-store'

const unreadSyncSchema = z.object({
  channels: z.record(z.string(), z.number()),
})

/**
 * WHY: Handles the `unread.sync` SSE event — an authoritative snapshot of all
 * channels with unread messages, sent by the server on connect and reconnect.
 * Replaces the entire Zustand store via `sync()`.
 *
 * Follows the exact pattern of use-presence.ts:143-163 (handlePresenceSync).
 *
 * WHY here (not in ChatArea): this is global state that must be initialized
 * regardless of whether a channel is selected.
 */
export function useUnreadSync(userId: string | null): void {
  const sync = useUnreadStore((s) => s.sync)

  const handleUnreadSync = useCallback(
    (payload: unknown) => {
      if (userId === null) return

      const parsed = unreadSyncSchema.safeParse(payload)
      if (!parsed.success) {
        logger.warn('malformed_unread_sync_event', { error: parsed.error.message })
        return
      }

      sync(parsed.data.channels)
    },
    [userId, sync],
  )

  useServerEvent(userId !== null ? 'unread.sync' : null, handleUnreadSync)
}
