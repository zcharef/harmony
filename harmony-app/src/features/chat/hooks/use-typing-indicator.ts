import { useCallback, useEffect, useRef, useState } from 'react'
import { z } from 'zod'

import { useServerEvent } from '@/hooks/use-server-event'
import { sendTyping as sendTypingApi } from '@/lib/api'
import { logger } from '@/lib/logger'

// WHY Zod: SSE event payloads are external data (CLAUDE.md §1.2).
// WHY senderId: Matches the Rust ServerEvent::TypingStarted shape
// (event-types.ts:199-205). All SSE events use senderId, not userId.
const typingEventSchema = z.object({
  senderId: z.string(),
  serverId: z.string(),
  channelId: z.string(),
  username: z.string(),
})

// WHY minimal schema: We only need senderId + channelId from message.created
// to clear the typing indicator when a user sends a message.
const messageCreatedMinSchema = z.object({
  senderId: z.string(),
  channelId: z.string(),
})

export interface TypingUser {
  userId: string
  username: string
}

/**
 * Tracks typing indicators for a channel.
 *
 * Sending: POST to /v1/channels/{channelId}/typing via generated SDK (fire-and-forget, 3s throttle).
 * Receiving: Listens for `typing.started` SSE events via useServerEvent.
 *
 * WHY fire-and-forget POST: Typing is ephemeral and cosmetic. A failed POST
 * just means one typing indicator is missed — not worth retrying or surfacing.
 */
export function useTypingIndicator(channelId: string, currentUserId: string) {
  const [typingUsers, setTypingUsers] = useState<TypingUser[]>([])

  // WHY: Track expiry timers by userId to prevent timer leaks. Without this,
  // each typing event spawns a setTimeout that is never cleared — timers
  // accumulate when the same user keeps typing, and leak on channel change/unmount.
  const expiryTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  // WHY: Reset typing users when channel changes to avoid stale indicators
  // from the previous channel bleeding into the new one.
  const prevChannelRef = useRef(channelId)
  useEffect(() => {
    if (prevChannelRef.current !== channelId) {
      setTypingUsers([])
      // WHY: Clear all pending expiry timers — they belong to the old channel.
      for (const timer of expiryTimersRef.current.values()) {
        clearTimeout(timer)
      }
      expiryTimersRef.current.clear()
      prevChannelRef.current = channelId
    }
  }, [channelId])

  // WHY: Clear all timers on unmount to prevent setState calls on an unmounted component.
  useEffect(() => {
    return () => {
      for (const timer of expiryTimersRef.current.values()) {
        clearTimeout(timer)
      }
      expiryTimersRef.current.clear()
    }
  }, [])

  // WHY useServerEvent: Matches the pattern used by all other feature hooks
  // (e.g. use-realtime-members.ts:156-158). useServerEvent handles the
  // 'sse:' prefix and cleanup automatically.
  const handleTypingEvent = useCallback(
    (payload: unknown) => {
      if (channelId.length === 0 || currentUserId.length === 0) return

      const parsed = typingEventSchema.safeParse(payload)
      if (!parsed.success) {
        logger.warn('malformed_typing_sse_event', { error: parsed.error.message })
        return
      }

      const { senderId, username, channelId: eventChannelId } = parsed.data

      // WHY: Only process events for the current channel
      if (eventChannelId !== channelId) return
      // WHY: Don't show the current user's own typing indicator
      if (senderId === currentUserId) return

      setTypingUsers((prev) => {
        const exists = prev.some((u) => u.userId === senderId)
        return exists ? prev : [...prev, { userId: senderId, username }]
      })

      // WHY: 5-second expiry — if we don't receive another typing event
      // from this user within 5s, they likely stopped typing.
      // Clear any existing timer for this user before starting a new one
      // to prevent multiple timers accumulating for the same user.
      const existingTimer = expiryTimersRef.current.get(senderId)
      if (existingTimer !== undefined) {
        clearTimeout(existingTimer)
      }
      const timer = setTimeout(() => {
        setTypingUsers((prev) => {
          const next = prev.filter((u) => u.userId !== senderId)
          return next.length === prev.length ? prev : next
        })
        expiryTimersRef.current.delete(senderId)
      }, 5000)
      expiryTimersRef.current.set(senderId, timer)
    },
    [channelId, currentUserId],
  )

  // WHY: When a user sends a message, immediately clear their typing indicator
  // instead of waiting for the 5-second expiry. Without this, the typing dots
  // linger for up to 5s after the message already appeared in chat.
  const handleMessageCreated = useCallback(
    (payload: unknown) => {
      const parsed = messageCreatedMinSchema.safeParse(payload)
      if (!parsed.success) return

      const { senderId, channelId: eventChannelId } = parsed.data
      if (eventChannelId !== channelId) return

      const existingTimer = expiryTimersRef.current.get(senderId)
      if (existingTimer !== undefined) {
        clearTimeout(existingTimer)
        expiryTimersRef.current.delete(senderId)
      }

      setTypingUsers((prev) => {
        const next = prev.filter((u) => u.userId !== senderId)
        return next.length === prev.length ? prev : next
      })
    },
    [channelId],
  )

  const isActive = channelId.length > 0 && currentUserId.length > 0
  useServerEvent(isActive ? 'typing.started' : null, handleTypingEvent)
  useServerEvent(isActive ? 'message.created' : null, handleMessageCreated)

  // WHY: 3-second throttle prevents flooding the API with typing POSTs.
  // Typing events are cosmetic — losing a few is acceptable, but
  // sending one per keystroke would waste bandwidth.
  const lastSent = useRef(0)
  const sendTyping = useCallback(
    (_username: string) => {
      if (channelId.length === 0) return

      const now = Date.now()
      if (now - lastSent.current < 3000) return
      lastSent.current = now

      // WHY fire-and-forget: Background operation — no user-facing feedback needed
      // on failure (ADR-028). The POST just signals "user is typing" to the server.
      sendTypingApi({ path: { id: channelId }, throwOnError: true }).catch((error: unknown) => {
        logger.warn('typing_post_failed', {
          channelId,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    },
    [channelId],
  )

  return { typingUsers, sendTyping }
}
