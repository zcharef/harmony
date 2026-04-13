import { useQueryClient } from '@tanstack/react-query'
import type React from 'react'
import { useCallback, useEffect, useRef } from 'react'
import type { VoiceParticipantResponse } from '@/lib/api'
import {
  joinVoice,
  leaveVoice,
  refreshVoiceToken,
  updateVoiceState,
  voiceHeartbeat,
} from '@/lib/api'
import { isProblemDetails } from '@/lib/api-error'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'
import { supabase } from '@/lib/supabase'
import { fireAndForgetVoiceLeave } from '@/lib/voice-cleanup'
import { playVoiceSound } from '../lib/voice-sounds'
import {
  consumeHasSpokenSinceLastHeartbeat,
  useVoiceConnectionStore,
} from '../stores/voice-connection-store'
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

/** WHY: Extracted to reduce handleJoinVoice cognitive complexity below Biome's
 * limit of 15. Inserts self into the participant cache after storeConnect
 * confirms the LiveKit connection. Self-joined SSE events are skipped
 * (isSelfJoinedEvent in use-realtime-voice.ts), so this is the only path
 * that adds self — ensuring the name appears only after audio is connected.
 * Mirrors evictFromPreviousChannel: direct setQueryData, no network round-trip. */
function insertSelfIntoParticipantCache(
  channelId: string,
  userId: string | undefined,
  queryClient: ReturnType<typeof useQueryClient>,
): void {
  if (userId === undefined) return
  const room = useVoiceConnectionStore.getState().room
  const displayName = room?.localParticipant.name ?? ''

  queryClient.setQueryData<VoiceParticipantResponse[]>(
    queryKeys.voice.participants(channelId),
    (old) => {
      const baseline = old ?? []
      if (baseline.some((p) => p.userId === userId)) return baseline
      return [
        ...baseline,
        {
          channelId,
          userId,
          displayName,
          joinedAt: new Date().toISOString(),
          isMuted: false,
          isDeafened: false,
        },
      ]
    },
  )
}

/** WHY: Extracted to reduce scheduleTokenRefresh cognitive complexity below
 * Biome's limit of 15. Handles the successful token refresh: reconnects to
 * LiveKit if still in the same channel, updates TTL, resets retry count, and
 * re-schedules the next refresh cycle. */
async function handleTokenRefreshSuccess(
  refreshData: { token: string; url: string; ttlSecs?: number },
  refreshChannelId: string,
  refreshServerId: string,
  storeConnect: (channelId: string, serverId: string, token: string, url: string) => Promise<void>,
  ttlSecsRef: React.MutableRefObject<number>,
  refreshRetryCountRef: React.MutableRefObject<number>,
  reschedule: () => void,
): Promise<void> {
  const store = useVoiceConnectionStore.getState()
  // WHY: Only reconnect if still in the same channel. If the user
  // switched channels or disconnected, skip the refresh.
  if (store.currentChannelId === refreshChannelId && store.room !== null) {
    await storeConnect(refreshChannelId, refreshServerId, refreshData.token, refreshData.url)
    // WHY: Update TTL from the fresh response so the next cycle
    // uses the server's latest value (may change across plans).
    ttlSecsRef.current = refreshData.ttlSecs ?? FALLBACK_TOKEN_TTL_SECS
    refreshRetryCountRef.current = 0
    logger.info('voice_token_refreshed', { channelId: refreshChannelId })

    reschedule()
  }
}

/** WHY: Extracted to reduce scheduleTokenRefresh cognitive complexity below
 * Biome's limit of 15. Handles token refresh errors: non-retryable 4xx errors
 * force-disconnect immediately; 5xx/network errors retry with capped exponential
 * backoff up to 5 attempts before force-disconnecting. */
function handleTokenRefreshError(
  err: unknown,
  refreshChannelId: string,
  storeDisconnect: () => Promise<void>,
  refreshRetryCountRef: React.MutableRefObject<number>,
  rescheduleWithDelay: (delayMs: number) => void,
  evictSelf: () => void,
): void {
  // WHY: Non-retryable errors (4xx = kicked, session gone, bad input)
  // should immediately disconnect. Only 5xx and network errors are
  // worth retrying with backoff.
  const isNonRetryable = isProblemDetails(err) && err.status !== undefined && err.status < 500
  if (isNonRetryable) {
    logger.warn('voice_token_refresh_non_retryable', {
      error: err instanceof Error ? err.message : String(err),
      channelId: refreshChannelId,
      status: isProblemDetails(err) ? err.status : undefined,
    })
    evictSelf()
    storeDisconnect().catch((disconnectErr: unknown) => {
      logger.warn('voice_refresh_disconnect_failed', {
        error: disconnectErr instanceof Error ? disconnectErr.message : String(disconnectErr),
      })
    })
    return
  }

  const retries = refreshRetryCountRef.current
  if (retries < 5) {
    refreshRetryCountRef.current = retries + 1
    const backoffMs = Math.min(30_000 * 2 ** retries, 300_000)
    rescheduleWithDelay(backoffMs)
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
    // WHY: After 5 retries the token is expired and the LiveKit
    // connection is dead. Force disconnect so the user sees
    // 'disconnected' instead of a silent ghost call.
    evictSelf()
    storeDisconnect().catch((disconnectErr: unknown) => {
      logger.warn('voice_refresh_exhausted_disconnect_failed', {
        error: disconnectErr instanceof Error ? disconnectErr.message : String(disconnectErr),
      })
    })
  }
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

  // WHY: Captures the local user's Supabase ID on join so the unexpected-
  // disconnect effect can evict the user from the participant cache. By the
  // time the Disconnected event fires, room is already null and the identity
  // is no longer accessible via room.localParticipant.identity.
  const localUserIdRef = useRef<string | undefined>(undefined)

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

  // WHY: During storeConnect (Room teardown + new Room), the heartbeat interval
  // may fire with a stale session_id before React re-renders and clears the
  // interval. This flag tells the heartbeat's 404 handler to skip the
  // force-disconnect during the refresh window.
  const isRefreshingRef = useRef(false)

  const clearTokenRefreshTimer = useCallback(() => {
    if (tokenRefreshTimerRef.current !== null) {
      clearTimeout(tokenRefreshTimerRef.current)
      tokenRefreshTimerRef.current = null
    }
  }, [])

  // WHY: Server-initiated disconnects (AFK/alone/stale sweep) call
  // storeDisconnect() which sets status to 'idle' directly, bypassing the
  // 'disconnected' status that the unexpected-disconnect effect watches.
  // The SSE Left event is also blocked by isSelfLeftWhileConnected().
  // Without explicit eviction here, the user's name lingers in the
  // participant cache (ghost name, no toggles).
  const evictSelfFromParticipantCache = useCallback(() => {
    const channelId = channelIdRef.current
    const userId = localUserIdRef.current
    if (channelId !== null && userId !== undefined) {
      queryClient.setQueryData<VoiceParticipantResponse[]>(
        queryKeys.voice.participants(channelId),
        (old) => old?.filter((p) => p.userId !== userId),
      )
    }
  }, [queryClient])

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
        const sid = sessionIdRef.current
        if (refreshChannelId === null || refreshServerId === null || sid === null) {
          logger.warn('voice_token_refresh_skipped', {
            channelId: refreshChannelId,
            hasSession: sid !== null,
          })
          return
        }

        isRefreshingRef.current = true

        refreshVoiceToken({
          body: { sessionId: sid },
          throwOnError: true,
        })
          .then(({ data: refreshData }) =>
            handleTokenRefreshSuccess(
              refreshData,
              refreshChannelId,
              refreshServerId,
              storeConnect,
              ttlSecsRef,
              refreshRetryCountRef,
              () => scheduleTokenRefresh(),
            ),
          )
          .catch((err: unknown) =>
            handleTokenRefreshError(
              err,
              refreshChannelId,
              storeDisconnect,
              refreshRetryCountRef,
              (delayMs) => scheduleTokenRefresh(delayMs),
              evictSelfFromParticipantCache,
            ),
          )
          .finally(() => {
            isRefreshingRef.current = false
          })
      }, refreshAtMs)
    },
    [storeConnect, storeDisconnect, clearTokenRefreshTimer, evictSelfFromParticipantCache],
  )

  const handleJoinVoice = useCallback(
    async (channelId: string, serverId: string) => {
      if (isJoiningRef.current) return
      isJoiningRef.current = true
      // WHY: Cancel any in-flight token refresh to prevent a concurrent
      // refresh from racing with this join on the same Room instance.
      clearTokenRefreshTimer()
      isRefreshingRef.current = false
      try {
        // WHY: Cache auth token for beforeunload cleanup. getSession() reads
        // from memory and resolves instantly, but is async so we can't call it
        // inside the synchronous beforeunload handler.
        const { data: sessionData } = await supabase.auth.getSession()
        cachedAuthToken = sessionData.session?.access_token ?? null
        const userId = sessionData.session?.user?.id
        localUserIdRef.current = userId

        const { data } = await joinVoice({
          path: { id: channelId },
          throwOnError: true,
        })

        // WHY: The server atomically replaces the old session on join. Remove
        // the user from the previous channel's participant cache immediately so
        // the sidebar updates without waiting for the SSE event (which depends
        // on broadcast timing and the 500ms debounce in useRealtimeVoice).
        // WHY: Skip eviction when reconnecting to the same channel — the user is
        // already in the list and removing them causes a flash disappearance.
        if (data.previousChannelId !== channelId) {
          evictFromPreviousChannel(data.previousChannelId, userId, queryClient)
        }

        await storeConnect(channelId, serverId, data.token, data.url)
        playVoiceSound('join')
        // WHY: Self-joined SSE events are skipped (isSelfJoinedEvent) to prevent
        // the name appearing before audio is connected. Now that storeConnect
        // confirmed the connection, insert self into the cache directly. Uses
        // setQueryData (not invalidateQueries) to avoid a race where SSE events
        // arriving during a refetch could be clobbered by the REST response.
        // Mirrors the evictFromPreviousChannel pattern.
        insertSelfIntoParticipantCache(channelId, userId, queryClient)
        sessionIdRef.current = data.sessionId
        // WHY (H2): Reset the guard so the mute/deaf sync useEffect skips the
        // initial post-join render (server already has is_muted=false from upsert).
        isInitialMuteDeafRef.current = true
        // WHY: Store the server-provided TTL so scheduleTokenRefresh uses the
        // dynamic value instead of the hardcoded fallback.
        ttlSecsRef.current = data.ttlSecs ?? FALLBACK_TOKEN_TTL_SECS

        // WHY: Schedule token refresh at 80% of TTL. When the timer fires,
        // we fetch a fresh token from the API and reconnect the LiveKit room.
        // This is a background op — failure is logged, not surfaced (ADR-028).
        scheduleTokenRefresh()
      } catch (err: unknown) {
        const rawMessage = err instanceof Error ? err.message : String(err)
        logger.error('voice_join_api_failed', { error: rawMessage, channelId, serverId })
        // WHY: ProblemDetails from our API have user-friendly detail messages.
        // LiveKit SDK errors contain raw WebSocket URLs — not user-friendly.
        // Passing null lets VoiceConnectionBar fall through to the i18n
        // 'connectionFailed' translation key (ADR-028).
        // WHY: rawMessage is String(err) which produces "[object Object]" for
        // ProblemDetails (plain objects, not Error instances). Use .detail directly.
        const userMessage = isProblemDetails(err) ? err.detail : null
        useVoiceConnectionStore.setState({ status: 'failed', error: userMessage })

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
    [storeConnect, scheduleTokenRefresh, queryClient, clearTokenRefreshTimer],
  )

  const handleLeaveVoice = useCallback(async () => {
    const channelId = channelIdRef.current

    playVoiceSound('leave')
    clearTokenRefreshTimer()
    sessionIdRef.current = null
    localUserIdRef.current = undefined
    cachedAuthToken = null

    // WHY: Directly evict self from the participant cache so the sidebar
    // updates instantly without waiting for the SSE voice.state_update(left)
    // event. This also prevents a race where the SSE event arrives after
    // storeDisconnect clears currentChannelId.
    const userId = useVoiceConnectionStore.getState().room?.localParticipant.identity
    if (channelId !== null && userId !== undefined) {
      queryClient.setQueryData<VoiceParticipantResponse[]>(
        queryKeys.voice.participants(channelId),
        (old) => old?.filter((p) => p.userId !== userId),
      )
    }

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
  }, [storeDisconnect, clearTokenRefreshTimer, queryClient])

  // --- Heartbeat while connected or reconnecting ---
  useEffect(() => {
    // WHY: Continue heartbeats during 'reconnecting' (ICE restart). If we stop,
    // the server sweeps the session after 45s. The user would lose their voice
    // slot even though the LiveKit connection is attempting recovery.
    if (status !== 'connected' && status !== 'reconnecting') return

    const intervalId = setInterval(() => {
      const sid = sessionIdRef.current
      if (sid === null) return
      const room = useVoiceConnectionStore.getState().room
      voiceHeartbeat({
        body: {
          sessionId: sid,
          isActive: consumeHasSpokenSinceLastHeartbeat(),
          isMuted:
            room !== null
              ? !room.localParticipant.isMicrophoneEnabled
              : useVoiceConnectionStore.getState().isMuted,
        },
        throwOnError: true,
      }).catch((err: unknown) => {
        // WHY (P0-3): A 404 means the server-side session no longer exists
        // (e.g., swept after timeout, or server restarted). Force a clean
        // client teardown so the user does not stay in a ghost call.
        if (isProblemDetails(err) && err.status === 404) {
          // WHY: During token refresh, joinVoice atomically replaces the DB
          // session before the client reconnects. A heartbeat using the stale
          // session_id will 404 — this is expected and transient. Forcing a
          // disconnect here would kill the in-progress refresh, causing the
          // original token to expire (~1h) and produce robotic audio.
          if (isRefreshingRef.current) {
            logger.info('voice_heartbeat_404_during_refresh', {
              sessionId: sid,
            })
            return
          }

          logger.warn('voice_heartbeat_session_gone', {
            sessionId: sid,
          })
          evictSelfFromParticipantCache()
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
  }, [status, storeDisconnect, evictSelfFromParticipantCache])

  // --- Sync mute/deaf state to server on toggle ---
  // WHY (H2): Ref is reset to true in handleJoinVoice after storeConnect so
  // the first post-join render is always skipped (server has correct state).
  const isInitialMuteDeafRef = useRef(true)
  const muteDeafTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    // WHY: Skip the initial render — both start as false and the server
    // already has the correct state from the join (reset to false on upsert).
    if (isInitialMuteDeafRef.current) {
      isInitialMuteDeafRef.current = false
      return
    }
    // WHY (C2): Read status imperatively instead of as a dependency. This
    // prevents spurious API calls on every connect/reconnect/ICE transition.
    const currentStatus = useVoiceConnectionStore.getState().status
    if (currentStatus !== 'connected' && currentStatus !== 'reconnecting') return
    const sid = sessionIdRef.current
    if (sid === null) return

    // WHY (M1): 200ms trailing debounce collapses rapid mute toggles into a
    // single API call. The last-value-wins semantics make this safe.
    if (muteDeafTimerRef.current !== null) clearTimeout(muteDeafTimerRef.current)
    muteDeafTimerRef.current = setTimeout(() => {
      muteDeafTimerRef.current = null
      updateVoiceState({
        body: { sessionId: sid, isMuted, isDeafened },
        throwOnError: true,
      }).catch((err: unknown) => {
        // WHY (M3): 404 means session expired — force-disconnect immediately
        // instead of waiting for the next heartbeat cycle (up to 15s).
        if (isProblemDetails(err) && err.status === 404) {
          logger.warn('voice_state_update_session_gone', { sessionId: sid })
          evictSelfFromParticipantCache()
          storeDisconnect().catch((disconnectErr: unknown) => {
            logger.warn('voice_state_disconnect_failed', {
              error: disconnectErr instanceof Error ? disconnectErr.message : String(disconnectErr),
            })
          })
          return
        }
        logger.warn('voice_state_update_failed', {
          error: err instanceof Error ? err.message : String(err),
          isMuted,
          isDeafened,
        })
      })
    }, 200)

    return () => {
      if (muteDeafTimerRef.current !== null) {
        clearTimeout(muteDeafTimerRef.current)
        muteDeafTimerRef.current = null
      }
    }
  }, [isMuted, isDeafened, storeDisconnect, evictSelfFromParticipantCache])

  // WHY: Capture channelId before it's cleared to null on disconnect,
  // so the unexpected-disconnect leave effect can reference it.
  const prevChannelIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (currentChannelId !== null) {
      prevChannelIdRef.current = currentChannelId
    }
  }, [currentChannelId])

  // WHY: When LiveKit disconnects unexpectedly (server down, network loss),
  // the store sets status to 'disconnected' but never notifies our API.
  // This best-effort leave call reduces the ghost participant window from
  // 75s (sweep) to near-zero.
  useEffect(() => {
    if (status !== 'disconnected') return
    const channelId = prevChannelIdRef.current
    if (channelId === null) return

    // WHY: Immediately evict self from the participant cache so the sidebar
    // removes our name. Without this, the user sees their name in the voice
    // channel (from the stale cache) but has no VoiceConnectionBar to
    // disconnect — confusing ghost state until the leave API + SSE cycle
    // completes (or the 45s sweep if the leave API fails).
    const userId = localUserIdRef.current
    if (userId !== undefined) {
      queryClient.setQueryData<VoiceParticipantResponse[]>(
        queryKeys.voice.participants(channelId),
        (old) => old?.filter((p) => p.userId !== userId),
      )
    }

    leaveVoice({ path: { id: channelId }, throwOnError: true }).catch((err: unknown) => {
      logger.warn('voice_unexpected_disconnect_leave_failed', {
        error: err instanceof Error ? err.message : String(err),
        channelId,
      })
    })
  }, [status, queryClient])

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

  // WHY: Keep cachedAuthToken fresh so the beforeunload handler
  // can send a valid leave request even after JWT rotation (~1h).
  // Without this, a page refresh after token rotation sends an expired
  // Bearer token and the leave request is rejected (401).
  useEffect(() => {
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.access_token !== undefined) {
        cachedAuthToken = session.access_token
      } else {
        cachedAuthToken = null
      }
    })
    return () => {
      subscription.unsubscribe()
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
