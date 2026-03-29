import { useCallback, useEffect, useRef, useState } from 'react'
import { z } from 'zod'

import { useServerEvent } from '@/hooks/use-server-event'
import { env } from '@/lib/env'
import { logger } from '@/lib/logger'
import { supabase } from '@/lib/supabase'

// WHY Zod: SSE event payloads are external data (CLAUDE.md §1.2).
// WHY senderId: Matches the Rust ServerEvent::TypingStarted shape
// (event-types.ts:199-205). All SSE events use senderId, not userId.
const typingEventSchema = z.object({
  senderId: z.string(),
  serverId: z.string(),
  channelId: z.string(),
  username: z.string(),
})

export interface TypingUser {
  userId: string
  username: string
}

/**
 * WHY: Centralize auth-header retrieval for fire-and-forget fetches that
 * bypass the generated API client (endpoints not yet in the OpenAPI spec).
 * Matches the pattern in api-client.ts:21-23.
 */
async function getAuthHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (token === undefined) return {}
  return { Authorization: `Bearer ${token}` }
}

/**
 * Tracks typing indicators for a channel.
 *
 * Sending: POST to /v1/channels/{channelId}/typing (fire-and-forget, 3s throttle).
 * Receiving: Listens for `typing.started` SSE events via useServerEvent.
 *
 * WHY fire-and-forget POST: Typing is ephemeral and cosmetic. A failed POST
 * just means one typing indicator is missed — not worth retrying or surfacing.
 */
export function useTypingIndicator(channelId: string, currentUserId: string) {
  const [typingUsers, setTypingUsers] = useState<TypingUser[]>([])

  // WHY: Reset typing users when channel changes to avoid stale indicators
  // from the previous channel bleeding into the new one.
  const prevChannelRef = useRef(channelId)
  useEffect(() => {
    if (prevChannelRef.current !== channelId) {
      setTypingUsers([])
      prevChannelRef.current = channelId
    }
  }, [channelId])

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
      setTimeout(() => {
        setTypingUsers((prev) => prev.filter((u) => u.userId !== senderId))
      }, 5000)
    },
    [channelId, currentUserId],
  )

  const isActive = channelId.length > 0 && currentUserId.length > 0
  useServerEvent(isActive ? 'typing.started' : null, handleTypingEvent)

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
      getAuthHeaders()
        .then((headers) =>
          fetch(`${env.VITE_API_URL}/v1/channels/${channelId}/typing`, {
            method: 'POST',
            headers,
          }),
        )
        .catch((error: unknown) => {
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
