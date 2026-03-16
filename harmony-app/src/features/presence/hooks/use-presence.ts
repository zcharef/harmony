import { useEffect, useRef } from 'react'
import { z } from 'zod'

import type { UserStatus } from '@/lib/api'
import { logger } from '@/lib/logger'
import { supabase } from '@/lib/supabase'
import { usePresenceStore } from '../stores/presence-store'

const IDLE_TIMEOUT_MS = 300_000
const IDLE_CHECK_INTERVAL_MS = 30_000
const ACTIVITY_EVENTS = ['mousemove', 'keydown', 'pointerdown'] as const

/**
 * WHY Zod: Supabase Presence payloads are external data from a WebSocket.
 * CLAUDE.md §1.2 mandates Zod validation for all external data. Without it,
 * a malformed presence payload would corrupt the presence store silently.
 */
const presencePayloadSchema = z.object({
  userId: z.string(),
  status: z.enum(['online', 'idle', 'dnd', 'offline'] satisfies [UserStatus, ...UserStatus[]]),
})

/**
 * Subscribes to Supabase Presence for a server and tracks the current user's
 * online/idle status based on window activity.
 *
 * WHY a single `sync` handler instead of `join`/`leave`: the `sync` event fires
 * on every state change and gives the full presence map. Rebuilding from the
 * complete state avoids stale-entry bugs that arise from incremental join/leave
 * bookkeeping (documented in docs/architecture/03-realtime.md:238-246).
 */
export function usePresence(serverId: string | null, userId: string | null): void {
  const lastActivityRef = useRef(Date.now())
  const isIdleRef = useRef(false)

  useEffect(() => {
    if (serverId === null || userId === null) return

    const { syncPresenceState, clearAll } = usePresenceStore.getState()

    const channel = supabase.channel(`presence:${serverId}`)

    channel
      .on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState()
        const users = new Map<string, UserStatus>()

        for (const [, presences] of Object.entries(state)) {
          for (const p of presences) {
            const parsed = presencePayloadSchema.safeParse(p)
            if (!parsed.success) {
              logger.warn('Malformed presence payload, skipping entry', {
                serverId,
                error: parsed.error.message,
              })
              continue
            }
            users.set(parsed.data.userId, parsed.data.status)
          }
        }

        syncPresenceState(users)
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await channel.track({ userId, status: 'online' })
        }
      })

    // --- Activity tracking ---

    function onActivity() {
      lastActivityRef.current = Date.now()

      // WHY guard: avoid redundant track() calls when already online
      if (isIdleRef.current) {
        isIdleRef.current = false
        channel.track({ userId, status: 'online' })
      }
    }

    function onVisibilityChange() {
      if (document.hidden) {
        isIdleRef.current = true
        channel.track({ userId, status: 'idle' })
      } else {
        // WHY: treat focus-back as activity so the idle timer resets
        onActivity()
      }
    }

    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, onActivity, { passive: true })
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    const idleInterval = setInterval(() => {
      const elapsed = Date.now() - lastActivityRef.current
      if (elapsed >= IDLE_TIMEOUT_MS && !isIdleRef.current) {
        isIdleRef.current = true
        channel.track({ userId, status: 'idle' })
      }
    }, IDLE_CHECK_INTERVAL_MS)

    // --- Cleanup ---

    return () => {
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, onActivity)
      }
      document.removeEventListener('visibilitychange', onVisibilityChange)
      clearInterval(idleInterval)
      supabase.removeChannel(channel)
      clearAll()
    }
  }, [serverId, userId])
}
