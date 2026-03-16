import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'

interface TypingUser {
  userId: string
  username: string
}

/**
 * WHY Broadcast (not Postgres Changes): Typing indicators are ephemeral
 * and high-frequency. Persisting them to the database would create
 * unnecessary writes and latency. Supabase Broadcast is fire-and-forget
 * over the existing WebSocket — zero DB round-trips.
 *
 * See: docs/architecture/03-realtime.md lines 151-213
 */
export function useTypingIndicator(channelId: string, currentUserId: string) {
  const [typingUsers, setTypingUsers] = useState<TypingUser[]>([])
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null)

  useEffect(() => {
    // WHY: Empty channelId or userId means no context — don't subscribe
    if (channelId.length === 0 || currentUserId.length === 0) return

    const channel = supabase.channel(`typing:${channelId}`)

    channel
      .on('broadcast', { event: 'typing' }, (payload) => {
        const user = payload.payload as TypingUser
        if (user.userId === currentUserId) return

        setTypingUsers((prev) => {
          const exists = prev.some((u) => u.userId === user.userId)
          return exists ? prev : [...prev, user]
        })

        // WHY: 5-second expiry — if we don't receive another typing event
        // from this user within 5s, they likely stopped typing.
        setTimeout(() => {
          setTypingUsers((prev) => prev.filter((u) => u.userId !== user.userId))
        }, 5000)
      })
      .subscribe()

    channelRef.current = channel

    return () => {
      supabase.removeChannel(channel)
    }
  }, [channelId, currentUserId])

  // WHY: 3-second throttle prevents flooding the Broadcast channel.
  // Typing events are cosmetic — losing a few is acceptable, but
  // sending one per keystroke would waste bandwidth for all subscribers.
  const lastSent = useRef(0)
  const sendTyping = useCallback(
    (username: string) => {
      const now = Date.now()
      if (now - lastSent.current < 3000) return
      lastSent.current = now

      channelRef.current?.send({
        type: 'broadcast',
        event: 'typing',
        payload: { userId: currentUserId, username } satisfies TypingUser,
      })
    },
    [currentUserId],
  )

  return { typingUsers, sendTyping }
}
