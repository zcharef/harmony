import { useEffect, useRef } from 'react'
import { z } from 'zod'

import type { UserStatus } from '@/lib/api'
import { logger } from '@/lib/logger'
import { supabase } from '@/lib/supabase'
import { usePresenceStore } from '../stores/presence-store'

type Channel = ReturnType<typeof supabase.channel>

const IDLE_TIMEOUT_MS = 300_000
const IDLE_CHECK_INTERVAL_MS = 30_000
const ACTIVITY_EVENTS = ['mousemove', 'keydown', 'pointerdown'] as const

const presencePayloadSchema = z.object({
  userId: z.string(),
  status: z.enum(['online', 'idle', 'dnd', 'offline'] satisfies [UserStatus, ...UserStatus[]]),
})

/**
 * WHY: Extract parsing into a function shared by the sync handler and the
 * immediate-read on server switch (Effect 3).
 */
function parsePresenceState(channel: Channel, serverId: string): Map<string, UserStatus> {
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

  return users
}

/**
 * Tracks the current user's online/idle status across ALL servers and
 * subscribes to Supabase Presence for member list display.
 *
 * WHY three effects:
 * - Effect 1: Own-user activity tracking — always runs when logged in, even
 *   with no server selected, so the sidebar status dot is never "Offline".
 * - Effect 2: Server channels — subscribes to ALL servers so friends see the
 *   user online everywhere, not just on the currently viewed server.
 * - Effect 3: On selected server change — immediately populates the member
 *   list store from the channel's current state without waiting for the next
 *   sync event.
 */
export function usePresence(
  serverIds: string[],
  selectedServerId: string | null,
  userId: string | null,
): void {
  const lastActivityRef = useRef(Date.now())
  const isIdleRef = useRef(false)
  const channelMapRef = useRef(new Map<string, Channel>())
  const selectedServerRef = useRef(selectedServerId)
  selectedServerRef.current = selectedServerId

  // Effect 1: Own-user activity tracking (always active when logged in)
  useEffect(() => {
    if (userId === null) return
    const uid = userId

    const { setUserStatus, removeUser } = usePresenceStore.getState()
    setUserStatus(uid, 'online')

    function updateStatus(status: UserStatus) {
      setUserStatus(uid, status)
      for (const ch of channelMapRef.current.values()) {
        ch.track({ userId: uid, status })
      }
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

  // Effect 2: Subscribe to presence channels for ALL servers.
  // WHY all servers: user must appear online to friends across every shared
  // server, not just the one they're currently viewing.
  const serverIdsKey = serverIds.join(',')

  useEffect(() => {
    if (userId === null || serverIds.length === 0) return
    const uid = userId

    const { syncPresenceState } = usePresenceStore.getState()
    const channels = new Map<string, Channel>()

    for (const sid of serverIds) {
      const ch = supabase.channel(`presence:${sid}`)

      // WHY ref check: sync handler fires on ALL channels, but we only
      // populate the member list store for the currently selected server.
      ch.on('presence', { event: 'sync' }, () => {
        if (sid !== selectedServerRef.current) return
        syncPresenceState(parsePresenceState(ch, sid))
      })

      ch.subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          const currentStatus: UserStatus = isIdleRef.current ? 'idle' : 'online'
          await ch.track({ userId: uid, status: currentStatus })
        }
      })

      channels.set(sid, ch)
    }

    channelMapRef.current = channels

    return () => {
      channels.forEach((ch) => supabase.removeChannel(ch))
      channelMapRef.current = new Map()

      // WHY: Preserve own status across teardowns so the sidebar panel
      // doesn't flash to "Offline" during server list changes.
      const { presenceMap } = usePresenceStore.getState()
      const ownStatus = presenceMap.get(uid)
      const ownOnly = new Map<string, UserStatus>()
      if (ownStatus !== undefined) {
        ownOnly.set(uid, ownStatus)
      }
      syncPresenceState(ownOnly)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- serverIdsKey is a stable serialization of serverIds
  }, [serverIdsKey, userId])

  // Effect 3: When selected server changes, immediately populate the store
  // from that channel's current presence state instead of waiting for the
  // next sync event (which may take seconds).
  useEffect(() => {
    if (selectedServerId === null) return

    const ch = channelMapRef.current.get(selectedServerId)
    if (ch === undefined) return

    const users = parsePresenceState(ch, selectedServerId)
    if (users.size > 0) {
      usePresenceStore.getState().syncPresenceState(users)
    }
  }, [selectedServerId])
}
