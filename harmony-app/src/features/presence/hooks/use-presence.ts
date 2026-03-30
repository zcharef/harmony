import { useCallback, useEffect, useRef } from 'react'
import { z } from 'zod'

import { useServerEvent } from '@/hooks/use-server-event'
import { type UserStatus, updatePresence } from '@/lib/api'
import { logger } from '@/lib/logger'
import { usePresenceStore } from '../stores/presence-store'

const IDLE_TIMEOUT_MS = 300_000
const IDLE_CHECK_INTERVAL_MS = 30_000
const ACTIVITY_EVENTS = ['mousemove', 'keydown', 'pointerdown'] as const

// WHY Zod: SSE event payloads are external data (CLAUDE.md §1.2).
const presenceEventSchema = z.object({
  userId: z.string(),
  status: z.enum(['online', 'idle', 'dnd', 'offline'] satisfies [UserStatus, ...UserStatus[]]),
})

/**
 * WHY fire-and-forget: Status changes are background operations. The server
 * is authoritative — if the POST fails, the next heartbeat or SSE reconnect
 * will correct state. No user-facing feedback needed (ADR-028).
 */
function postPresenceStatus(status: UserStatus): void {
  updatePresence({ body: { status }, throwOnError: true }).catch((error: unknown) => {
    logger.warn('presence_post_failed', {
      status,
      error: error instanceof Error ? error.message : String(error),
    })
  })
}

/**
 * Tracks the current user's online/idle status and subscribes to
 * presence changes from other users via SSE.
 *
 * WHY simplified from 3 effects to 2: The server now handles connect/disconnect
 * lifecycle. The client only needs to:
 * 1. Track local activity and POST status changes (online/idle)
 * 2. Receive PresenceChanged SSE events and update the Zustand store
 *
 * Parameters `_serverIds` and `_selectedServerId` are retained for call-site
 * compatibility (main-layout.tsx:179) but unused — the server manages
 * per-server presence broadcasting internally.
 */
export function usePresence(
  _serverIds: string[],
  _selectedServerId: string | null,
  userId: string | null,
): void {
  const lastActivityRef = useRef(Date.now())
  const isIdleRef = useRef(false)

  // Effect 1: Own-user activity tracking (always active when logged in).
  // Detects idle/active transitions and POSTs status changes to the API.
  useEffect(() => {
    if (userId === null) return
    const uid = userId

    const { setUserStatus, removeUser } = usePresenceStore.getState()
    setUserStatus(uid, 'online')
    postPresenceStatus('online')

    function updateStatus(status: UserStatus) {
      setUserStatus(uid, status)
      postPresenceStatus(status)
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

  // SSE listener: Receive presence.changed events and update the store.
  // WHY useServerEvent: Matches the pattern used by all other feature hooks
  // (e.g., use-realtime-members.ts). useServerEvent listens on the correct
  // dot-separated SSE event name ('sse:presence.changed').
  const handlePresenceEvent = useCallback(
    (payload: unknown) => {
      if (userId === null) return

      const parsed = presenceEventSchema.safeParse(payload)
      if (!parsed.success) {
        logger.warn('malformed_presence_sse_event', { error: parsed.error.message })
        return
      }

      const { userId: eventUserId, status } = parsed.data
      const { setUserStatus, removeUser } = usePresenceStore.getState()

      if (status === 'offline') {
        removeUser(eventUserId)
      } else {
        setUserStatus(eventUserId, status)
      }
    },
    [userId],
  )

  useServerEvent(userId !== null ? 'presence.changed' : null, handlePresenceEvent)
}
