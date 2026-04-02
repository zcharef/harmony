import { useCallback, useEffect, useRef } from 'react'
import { z } from 'zod'

import { usePreferences } from '@/features/preferences'
import { useServerEvent } from '@/hooks/use-server-event'
import { type UserStatus, updatePresence } from '@/lib/api'
import { logger } from '@/lib/logger'
import { usePresenceStore } from '../stores/presence-store'

const IDLE_TIMEOUT_MS = 300_000
const IDLE_CHECK_INTERVAL_MS = 30_000
const ACTIVITY_EVENTS = ['mousemove', 'keydown', 'pointerdown'] as const

// WHY Zod: SSE event payloads are external data (CLAUDE.md §1.2).
const userStatusSchema = z.enum(['online', 'idle', 'dnd', 'offline'] satisfies [
  UserStatus,
  ...UserStatus[],
])

const presenceEventSchema = z.object({
  userId: z.string(),
  status: userStatusSchema,
})

const presenceSyncSchema = z.object({
  users: z.record(z.string(), userStatusSchema),
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
 * presence updates from other users via SSE.
 *
 * Responsibilities:
 * 1. Track local activity and POST status changes (online/idle)
 * 2. Handle `presence.sync` snapshot on connect/reconnect (full state)
 * 3. Handle `presence.changed` deltas (incremental updates)
 */
export function usePresence(userId: string | null): void {
  const preferences = usePreferences()
  const preferencesReady = !preferences.isPending
  const dndEnabled = preferences.data?.dndEnabled === true
  const lastActivityRef = useRef(Date.now())
  const isIdleRef = useRef(false)

  // WHY single effect: DND and idle tracking share the same status destination
  // (store + API). Two separate effects caused ordering races where Effect 1
  // would set 'online' and Effect 2 would correct to 'dnd' one render later.
  // WHY preferencesReady gate: Without it, dndEnabled starts as false while
  // the query loads, causing a premature 'online' POST that the server echoes
  // to all peers before the corrective 'dnd' arrives.
  useEffect(() => {
    if (userId === null || !preferencesReady) return
    const uid = userId

    const { setUserStatus } = usePresenceStore.getState()

    function updateStatus(status: UserStatus) {
      setUserStatus(uid, status)
      postPresenceStatus(status)
    }

    // Compute correct initial status based on DND + actual activity.
    if (dndEnabled) {
      updateStatus('dnd')
      isIdleRef.current = false
    } else {
      const elapsed = Date.now() - lastActivityRef.current
      const shouldBeIdle = elapsed >= IDLE_TIMEOUT_MS
      isIdleRef.current = shouldBeIdle
      updateStatus(shouldBeIdle ? 'idle' : 'online')
    }

    // WHY: Activity/visibility handlers are no-ops during DND — the user's
    // status is locked to 'dnd' until they toggle the preference off.
    function onActivity() {
      lastActivityRef.current = Date.now()
      if (isIdleRef.current && !dndEnabled) {
        isIdleRef.current = false
        updateStatus('online')
      }
    }

    function onVisibilityChange() {
      if (dndEnabled) return
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
      if (dndEnabled) return
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
      // WHY: Don't removeUser here — this cleanup runs on every dndEnabled toggle,
      // not just on logout. Removing the user causes a store flash and lets stale
      // SSE echoes race with the new status. Logout cleanup is handled below.
    }
  }, [userId, dndEnabled, preferencesReady])

  // WHY separate effect: removeUser must only run on actual logout (userId → null),
  // not on every dndEnabled toggle. The main effect's cleanup fires on both cases,
  // so we isolate the logout-only cleanup here.
  useEffect(() => {
    if (userId === null) return
    const uid = userId
    return () => {
      usePresenceStore.getState().removeUser(uid)
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

      // WHY: Skip our own presence echoes. We already set our status locally
      // in the activity-tracking effect. Processing our own SSE echoes causes
      // a race where a stale 'online' echo overwrites a fresh 'dnd' toggle.
      // Our status is still included in presence.sync (reconnect), so eventual
      // consistency is preserved.
      if (eventUserId === userId) return

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

  // SSE listener: Receive presence.sync snapshot on connect/reconnect.
  // WHY: When a user connects, they have no knowledge of who is already online.
  // The server sends a full snapshot as the first SSE event. On reconnect, the
  // same event replaces any stale state. This is the "initial snapshot +
  // incremental deltas" pattern.
  const handlePresenceSync = useCallback(
    (payload: unknown) => {
      if (userId === null) return

      const parsed = presenceSyncSchema.safeParse(payload)
      if (!parsed.success) {
        logger.warn('malformed_presence_sync_event', { error: parsed.error.message })
        return
      }

      const map = new Map<string, UserStatus>()
      for (const [uid, status] of Object.entries(parsed.data.users)) {
        map.set(uid, status)
      }

      usePresenceStore.getState().syncPresenceState(map)
    },
    [userId],
  )

  useServerEvent(userId !== null ? 'presence.sync' : null, handlePresenceSync)
}
