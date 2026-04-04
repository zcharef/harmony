import { useCallback, useEffect, useRef } from 'react'
import { joinVoice, leaveVoice, voiceHeartbeat } from '@/lib/api'
import { isProblemDetails } from '@/lib/api-error'
import { logger } from '@/lib/logger'
import { useVoiceConnectionStore } from '../stores/voice-connection-store'
import { usePushToTalk } from './use-push-to-talk'

/** WHY: 15s heartbeat keeps the server-side voice session alive. */
const HEARTBEAT_INTERVAL_MS = 15_000

/** WHY: Fallback TTL (2h) used only if the API response is missing ttlSecs.
 * The server now returns ttlSecs in the join response — this is a defensive default. */
const FALLBACK_TOKEN_TTL_SECS = 2 * 60 * 60

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
  const isPttMode = useVoiceConnectionStore((s) => s.isPttMode)
  const pttShortcut = useVoiceConnectionStore((s) => s.pttShortcut)

  // WHY: Mount PTT global hotkey — passing null disables the shortcut registration.
  // When isPttMode is false, no shortcut is registered.
  usePushToTalk(isPttMode ? pttShortcut : null)

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

  // WHY: Stores the server-provided TTL so the recursive scheduleTokenRefresh
  // can read the latest value without needing it as a parameter each time.
  const ttlSecsRef = useRef<number>(FALLBACK_TOKEN_TTL_SECS)

  const clearTokenRefreshTimer = useCallback(() => {
    if (tokenRefreshTimerRef.current !== null) {
      clearTimeout(tokenRefreshTimerRef.current)
      tokenRefreshTimerRef.current = null
    }
  }, [])

  // WHY (P1-2): Extracted to a named function so the token refresh can
  // re-schedule itself after each successful cycle instead of being one-shot.
  // Uses ttlSecsRef so the timer duration tracks the server's dynamic TTL.
  const scheduleTokenRefresh = useCallback(() => {
    clearTokenRefreshTimer()
    const refreshAtMs = ttlSecsRef.current * 1_000 * 0.8
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
            // WHY: Update TTL from the fresh response so the next cycle
            // uses the server's latest value (may change across plans).
            ttlSecsRef.current = refreshData.ttlSecs ?? FALLBACK_TOKEN_TTL_SECS
            logger.info('voice_token_refreshed', { channelId: refreshChannelId })

            // WHY (P1-2): Re-schedule for the next TTL cycle. Without this,
            // the token refresh is one-shot and the session expires after 2x TTL.
            scheduleTokenRefresh()
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
    }, refreshAtMs)
  }, [storeConnect, clearTokenRefreshTimer])

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
        // WHY: Store the server-provided TTL so scheduleTokenRefresh uses the
        // dynamic value instead of the hardcoded fallback.
        ttlSecsRef.current = data.ttlSecs ?? FALLBACK_TOKEN_TTL_SECS

        // WHY: Schedule token refresh at 80% of TTL. When the timer fires,
        // we fetch a fresh token from the API and reconnect the LiveKit room.
        // This is a background op — failure is logged, not surfaced (ADR-028).
        scheduleTokenRefresh()
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        logger.error('voice_join_api_failed', { error: message, channelId, serverId })
        // WHY: Set store error for inline feedback (ADR-028). No toast.
        useVoiceConnectionStore.setState({ status: 'failed', error: message })

        // WHY (P1-5): If storeConnect (room.connect()) failed, the server-side
        // session created by joinVoice is still alive and will linger for 45s
        // until the sweep. Fire a best-effort leaveVoice to clean it up.
        leaveVoice({ path: { id: channelId }, throwOnError: true }).catch((leaveErr: unknown) => {
          logger.warn('voice_join_cleanup_leave_failed', {
            error: leaveErr instanceof Error ? leaveErr.message : String(leaveErr),
            channelId,
          })
        })
      } finally {
        isJoiningRef.current = false
      }
    },
    [storeConnect, scheduleTokenRefresh],
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
        // WHY (P0-3): A 404 means the server-side session no longer exists
        // (e.g., swept after timeout, or server restarted). Force a clean
        // client teardown so the user does not stay in a ghost call.
        if (isProblemDetails(err) && err.status === 404) {
          logger.warn('voice_heartbeat_session_gone', {
            sessionId: sid,
          })
          storeDisconnect().catch((disconnectErr: unknown) => {
            logger.warn('voice_heartbeat_disconnect_failed', {
              error: disconnectErr instanceof Error ? disconnectErr.message : String(disconnectErr),
            })
          })
          return
        }

        // WHY: For 429/5xx, keep current behavior — log only, no user
        // feedback (ADR-028). The session may still be alive.
        logger.warn('voice_heartbeat_failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }, HEARTBEAT_INTERVAL_MS)

    return () => {
      clearInterval(intervalId)
    }
  }, [status, storeDisconnect])

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
    isPttMode,
    pttShortcut,
    toggleMute,
    toggleDeafen,
    error,
    activeSpeakers,
  }
}
