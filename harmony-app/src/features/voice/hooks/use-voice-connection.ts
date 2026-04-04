import { useCallback, useEffect, useRef } from 'react'
import { joinVoice, leaveVoice, voiceHeartbeat } from '@/lib/api'
import { logger } from '@/lib/logger'
import { useVoiceConnectionStore } from '../stores/voice-connection-store'

/** WHY: 15s heartbeat keeps the server-side voice session alive. */
const HEARTBEAT_INTERVAL_MS = 15_000

/** WHY: Token TTL assumed 2h (7_200_000ms). Refresh at 80% to avoid expiry
 * mid-session. Hardcoded because the API does not return TTL in the response —
 * if the server TTL changes, update this constant. */
const TOKEN_TTL_MS = 2 * 60 * 60 * 1_000
const TOKEN_REFRESH_AT_MS = TOKEN_TTL_MS * 0.8

/**
 * Wraps the Zustand voice connection store with API integration.
 *
 * - joinVoice: calls API to get LiveKit token, then connects via store
 * - leaveVoice: disconnects via store, then notifies API (fire-and-forget)
 * - Heartbeat: sends periodic voiceHeartbeat while connected/reconnecting
 * - Token refresh: re-fetches token at 80% TTL and reconnects seamlessly
 * - Join guard: prevents overlapping join requests on rapid channel switches
 *
 * Error handling follows ADR-028: explicit user actions (join) set inline error
 * state on the store. Background ops (leave, heartbeat, token refresh) fail
 * silently with logging.
 */
export function useVoiceConnection() {
  const status = useVoiceConnectionStore((s) => s.status)
  const currentChannelId = useVoiceConnectionStore((s) => s.currentChannelId)
  const currentServerId = useVoiceConnectionStore((s) => s.currentServerId)
  const isMuted = useVoiceConnectionStore((s) => s.isMuted)
  const isDeafened = useVoiceConnectionStore((s) => s.isDeafened)
  const error = useVoiceConnectionStore((s) => s.error)
  const activeSpeakers = useVoiceConnectionStore((s) => s.activeSpeakers)
  const storeConnect = useVoiceConnectionStore((s) => s.connect)
  const storeDisconnect = useVoiceConnectionStore((s) => s.disconnect)
  const toggleMute = useVoiceConnectionStore((s) => s.toggleMute)
  const toggleDeafen = useVoiceConnectionStore((s) => s.toggleDeafen)

  // WHY: Ref for channelId so the heartbeat interval closure always reads the
  // latest value without needing to restart the interval on channelId change.
  const channelIdRef = useRef(currentChannelId)
  channelIdRef.current = currentChannelId

  const serverIdRef = useRef(currentServerId)
  serverIdRef.current = currentServerId

  // WHY: Prevents overlapping join requests when the user rapidly switches
  // voice channels. Without this guard, multiple simultaneous join API calls
  // race against the one-session-per-user server constraint.
  const isJoiningRef = useRef(false)

  // WHY: Holds the token refresh timer so it can be cleared on leave/unmount.
  const tokenRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // WHY: The server returns a session_id on join. Heartbeats send it back so
  // the server validates the heartbeat belongs to the current device session.
  const sessionIdRef = useRef<string | null>(null)

  const clearTokenRefreshTimer = useCallback(() => {
    if (tokenRefreshTimerRef.current !== null) {
      clearTimeout(tokenRefreshTimerRef.current)
      tokenRefreshTimerRef.current = null
    }
  }, [])

  const handleJoinVoice = useCallback(
    async (channelId: string, serverId: string) => {
      if (isJoiningRef.current) return
      isJoiningRef.current = true
      try {
        const { data } = await joinVoice({
          path: { id: channelId },
          throwOnError: true,
        })

        await storeConnect(channelId, serverId, data.token, data.url)
        sessionIdRef.current = data.sessionId

        // WHY: Schedule token refresh at 80% of TTL. When the timer fires,
        // we fetch a fresh token from the API and reconnect the LiveKit room.
        // This is a background op — failure is logged, not surfaced (ADR-028).
        clearTokenRefreshTimer()
        tokenRefreshTimerRef.current = setTimeout(() => {
          const refreshChannelId = channelIdRef.current
          const refreshServerId = serverIdRef.current
          if (refreshChannelId === null || refreshServerId === null) return

          joinVoice({ path: { id: refreshChannelId }, throwOnError: true })
            .then(async ({ data: refreshData }) => {
              const store = useVoiceConnectionStore.getState()
              // WHY: Only reconnect if still in the same channel. If the user
              // switched channels or disconnected, skip the refresh.
              if (store.currentChannelId === refreshChannelId && store.room !== null) {
                await storeConnect(
                  refreshChannelId,
                  refreshServerId,
                  refreshData.token,
                  refreshData.url,
                )
                sessionIdRef.current = refreshData.sessionId
                logger.info('voice_token_refreshed', { channelId: refreshChannelId })
              }
            })
            .catch((err: unknown) => {
              // WHY: Background op — log only, no user feedback (ADR-028).
              // The session will continue until the old token actually expires.
              logger.warn('voice_token_refresh_failed', {
                error: err instanceof Error ? err.message : String(err),
                channelId: refreshChannelId,
              })
            })
        }, TOKEN_REFRESH_AT_MS)
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        logger.error('voice_join_api_failed', { error: message, channelId, serverId })
        // WHY: Set store error for inline feedback (ADR-028). No toast.
        useVoiceConnectionStore.setState({ status: 'failed', error: message })
      } finally {
        isJoiningRef.current = false
      }
    },
    [storeConnect, clearTokenRefreshTimer],
  )

  const handleLeaveVoice = useCallback(async () => {
    const channelId = channelIdRef.current

    clearTokenRefreshTimer()
    sessionIdRef.current = null

    // WHY: Disconnect from LiveKit first so the user sees instant feedback.
    await storeDisconnect()

    // WHY: Fire-and-forget API call — background op, no user feedback (ADR-028).
    if (channelId !== null) {
      leaveVoice({ path: { id: channelId }, throwOnError: true }).catch((err: unknown) => {
        logger.warn('voice_leave_api_failed', {
          error: err instanceof Error ? err.message : String(err),
          channelId,
        })
      })
    }
  }, [storeDisconnect, clearTokenRefreshTimer])

  // --- Heartbeat while connected or reconnecting ---
  useEffect(() => {
    // WHY: Continue heartbeats during 'reconnecting' (ICE restart). If we stop,
    // the server sweeps the session after 45s. The user would lose their voice
    // slot even though the LiveKit connection is attempting recovery.
    if (status !== 'connected' && status !== 'reconnecting') return

    const intervalId = setInterval(() => {
      const sid = sessionIdRef.current
      if (sid === null) return
      voiceHeartbeat({ body: { sessionId: sid }, throwOnError: true }).catch((err: unknown) => {
        // WHY: Background op — log only, no user feedback (ADR-028).
        logger.warn('voice_heartbeat_failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }, HEARTBEAT_INTERVAL_MS)

    return () => {
      clearInterval(intervalId)
    }
  }, [status])

  // WHY: Clean up the token refresh timer on unmount to prevent stale
  // callbacks firing after the component tree is torn down.
  useEffect(() => {
    return () => {
      clearTokenRefreshTimer()
    }
  }, [clearTokenRefreshTimer])

  return {
    joinVoice: handleJoinVoice,
    leaveVoice: handleLeaveVoice,
    status,
    currentChannelId,
    isMuted,
    isDeafened,
    toggleMute,
    toggleDeafen,
    error,
    activeSpeakers,
  }
}
