import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef } from 'react'
import type { VoiceParticipantResponse } from '@/lib/api'
import { joinVoice, leaveVoice, voiceHeartbeat } from '@/lib/api'
import { isProblemDetails } from '@/lib/api-error'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'
import { supabase } from '@/lib/supabase'
import { fireAndForgetVoiceLeave } from '@/lib/voice-cleanup'
import { playVoiceSound } from '../lib/voice-sounds'
import { useVoiceConnectionStore } from '../stores/voice-connection-store'
import { usePushToTalk } from './use-push-to-talk'

/** WHY: Extracted to reduce handleJoinVoice cognitive complexity below Biome's
 * limit of 15. Removes the user from the previous channel's participant cache
 * so the sidebar updates instantly without waiting for the SSE debounce. */
function evictFromPreviousChannel(
  previousChannelId: string | null | undefined,
  userId: string | undefined,
  queryClient: ReturnType<typeof useQueryClient>,
): void {
  if (previousChannelId === undefined || previousChannelId === null) return
  if (userId === undefined) return

  queryClient.setQueryData<VoiceParticipantResponse[]>(
    queryKeys.voice.participants(previousChannelId),
    (old) => old?.filter((p) => p.userId !== userId),
  )
}

/** WHY: 15s heartbeat keeps the server-side voice session alive. */
const HEARTBEAT_INTERVAL_MS = 15_000

/** WHY: Cached auth token for the beforeunload handler. supabase.auth.getSession()
 * is async and cannot be awaited in the synchronous beforeunload callback.
 * Updated on every successful voice join. */
let cachedAuthToken: string | null = null

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

  const queryClient = useQueryClient()

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

  // WHY (F3): Tracks consecutive token refresh failures for capped backoff.
  // Reset to 0 on success; after 5 failures, stop retrying entirely.
  const refreshRetryCountRef = useRef(0)

  const clearTokenRefreshTimer = useCallback(() => {
    if (tokenRefreshTimerRef.current !== null) {
      clearTimeout(tokenRefreshTimerRef.current)
      tokenRefreshTimerRef.current = null
    }
  }, [])

  // WHY (P1-2): Extracted to a named function so the token refresh can
  // re-schedule itself after each successful cycle instead of being one-shot.
  // Uses ttlSecsRef so the timer duration tracks the server's dynamic TTL.
  // WHY (F3): Accepts optional delayMs override for backoff scheduling on failure.
  const scheduleTokenRefresh = useCallback(
    (delayMs?: number) => {
      clearTokenRefreshTimer()
      // WHY (P2-a): Floor guard prevents a 0 or near-0 TTL from causing
      // an infinite immediate-fire loop (minimum 48s refresh interval).
      const safeTtlSecs = Math.max(ttlSecsRef.current, 60)
      const refreshAtMs = delayMs ?? safeTtlSecs * 1_000 * 0.8
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
              // WHY (F3): Reset retry counter on success so the next failure
              // starts backoff from scratch.
              refreshRetryCountRef.current = 0
              logger.info('voice_token_refreshed', { channelId: refreshChannelId })

              // WHY (P1-2): Re-schedule for the next TTL cycle. Without this,
              // the token refresh is one-shot and the session expires after 2x TTL.
              scheduleTokenRefresh()
            }
          })
          .catch((err: unknown) => {
            // WHY (F3): Re-schedule with capped exponential backoff so a
            // single transient failure does not permanently kill the refresh loop.
            const retries = refreshRetryCountRef.current
            if (retries < 5) {
              refreshRetryCountRef.current = retries + 1
              const backoffMs = Math.min(30_000 * 2 ** retries, 300_000)
              scheduleTokenRefresh(backoffMs)
              logger.warn('voice_token_refresh_failed', {
                error: err instanceof Error ? err.message : String(err),
                channelId: refreshChannelId,
                retryIn: backoffMs,
                attempt: retries + 1,
              })
            } else {
              logger.error('voice_token_refresh_exhausted', {
                error: err instanceof Error ? err.message : String(err),
                channelId: refreshChannelId,
                attempts: retries,
              })
            }
          })
      }, refreshAtMs)
    },
    [storeConnect, clearTokenRefreshTimer],
  )

  const handleJoinVoice = useCallback(
    async (channelId: string, serverId: string) => {
      if (isJoiningRef.current) return
      isJoiningRef.current = true
      try {
        // WHY: Cache auth token for beforeunload cleanup. getSession() reads
        // from memory and resolves instantly, but is async so we can't call it
        // inside the synchronous beforeunload handler.
        const { data: sessionData } = await supabase.auth.getSession()
        cachedAuthToken = sessionData.session?.access_token ?? null

        const { data } = await joinVoice({
          path: { id: channelId },
          throwOnError: true,
        })

        // WHY: The server atomically replaces the old session on join. Remove
        // the user from the previous channel's participant cache immediately so
        // the sidebar updates without waiting for the SSE event (which depends
        // on broadcast timing and the 500ms debounce in useRealtimeVoice).
        evictFromPreviousChannel(data.previousChannelId, sessionData.session?.user?.id, queryClient)

        await storeConnect(channelId, serverId, data.token, data.url)
        playVoiceSound('join')
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
    [storeConnect, scheduleTokenRefresh, queryClient],
  )

  const handleLeaveVoice = useCallback(async () => {
    const channelId = channelIdRef.current

    playVoiceSound('leave')
    clearTokenRefreshTimer()
    sessionIdRef.current = null
    cachedAuthToken = null

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

  // WHY: On page refresh (F5), the LiveKit room disconnects (disconnectOnPageLeave)
  // but the server-side voice session stays alive until the heartbeat sweep (~45s).
  // This causes a ghost participant: the user's name lingers in the channel while
  // the voice UI resets to idle. Fire a best-effort leave request on beforeunload
  // so the server cleans up immediately.
  useEffect(() => {
    const handleBeforeUnload = () => {
      const { currentChannelId: channelId } = useVoiceConnectionStore.getState()
      if (channelId === null || cachedAuthToken === null) return

      fireAndForgetVoiceLeave(channelId, cachedAuthToken)
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [])

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
