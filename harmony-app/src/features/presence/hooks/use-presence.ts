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
 * Tracks the current user's online/idle status and subscribes to Supabase
 * Presence for a server.
 *
 * WHY two effects: Own-user activity tracking must always run (even with no
 * server selected) so the sidebar status dot reflects reality. The server
 * channel subscription is separate because it requires a serverId.
 */
export function usePresence(serverId: string | null, userId: string | null): void {
  const lastActivityRef = useRef(Date.now())
  const isIdleRef = useRef(false)
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null)

  // Effect 1: Own-user activity tracking (always active when logged in)
  useEffect(() => {
    if (userId === null) return
    const uid = userId

    const { setUserStatus, removeUser } = usePresenceStore.getState()
    setUserStatus(uid, 'online')

    function updateStatus(status: UserStatus) {
      setUserStatus(uid, status)
      channelRef.current?.track({ userId: uid, status })
    }

    function onActivity() {
      lastActivityRef.current = Date.now()
      if (isIdleRef.current) {
        isIdleRef.current = false
        updateStatus('online')
      }
    }

    function onVisibilityChange() {
      if (document.hidden) {
        isIdleRef.current = true
        updateStatus('idle')
      } else {
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
        updateStatus('idle')
      }
    }, IDLE_CHECK_INTERVAL_MS)

    return () => {
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, onActivity)
      }
      document.removeEventListener('visibilitychange', onVisibilityChange)
      clearInterval(idleInterval)
      removeUser(uid)
    }
  }, [userId])

  // Effect 2: Server presence channel (only when a server is selected)
  useEffect(() => {
    if (serverId === null || userId === null) return
    const uid = userId

    const { syncPresenceState } = usePresenceStore.getState()
    const channel = supabase.channel(`presence:${serverId}`)
    channelRef.current = channel

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
          const currentStatus: UserStatus = isIdleRef.current ? 'idle' : 'online'
          await channel.track({ userId: uid, status: currentStatus })
        }
      })

    return () => {
      channelRef.current = null
      supabase.removeChannel(channel)
      // WHY: Preserve own status when switching servers so the sidebar
      // panel doesn't flash to "Offline" between server changes.
      const { presenceMap } = usePresenceStore.getState()
      const ownStatus = presenceMap.get(uid)
      const ownOnly = new Map<string, UserStatus>()
      if (ownStatus !== undefined) {
        ownOnly.set(uid, ownStatus)
      }
      syncPresenceState(ownOnly)
    }
  }, [serverId, userId])
}
