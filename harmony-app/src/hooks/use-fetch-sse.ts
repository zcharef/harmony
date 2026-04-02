/**
 * Fetch-based SSE connection hook.
 *
 * WHY: Native EventSource cannot set Authorization headers. This fetch-based
 * approach sends Bearer tokens in headers, eliminating cookie auth entirely.
 *
 * Uses `eventsource-parser` to parse the SSE stream from a fetch response.
 * Dispatches parsed events via window CustomEvents (use-server-event.ts
 * consumers subscribe to these).
 *
 * Pattern reference: use-server-event.ts (event bridge consumer),
 * connection-store.ts (status management).
 *
 * Called once in MainLayout, gated on userId.
 */

import { useQueryClient } from '@tanstack/react-query'
import { createParser, type EventSourceMessage } from 'eventsource-parser'
import { useCallback, useEffect, useRef } from 'react'

import { useConnectionStore } from '@/lib/connection-store'
import { env } from '@/lib/env'
import { SSE_EVENT_NAMES, serverEventSchema } from '@/lib/event-types'
import { logger } from '@/lib/logger'

/** Exponential backoff delays in ms: 1s -> 2s -> 4s -> 8s -> 16s -> 30s (max). */
const BACKOFF_DELAYS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const

/** If no data received for this duration (ms), treat as disconnect. Server heartbeat is 30s. */
const HEARTBEAT_TIMEOUT_MS = 45_000

/** Safety net: max SSE connection lifetime. Supabase's TOKEN_REFRESHED event
 *  is the primary reconnect trigger (handled in AuthProvider). This timer is
 *  a fallback for when TOKEN_REFRESHED doesn't fire (tab backgrounded,
 *  auto-refresh failed). 55min gives a 5min buffer before a 1h JWT expires. */
const MAX_CONNECTION_LIFETIME_MS = 55 * 60 * 1_000

/** Delay before showing "reconnecting" status to avoid banner flash on normal rotation. */
const RECONNECT_GRACE_MS = 3_000

/** After this duration of continuous failure, escalate to 'disconnected'. */
const DISCONNECT_ESCALATION_MS = 30_000

const sseEventNameSet = new Set<string>(SSE_EVENT_NAMES)

// ── Types ────────────────────────────────────────────────────────────

type AbortReason = 'jwt-rotation' | 'heartbeat-timeout'

type ConnectResult = { status: number } | { networkError: true } | { aborted: true }

/**
 * Mutable state bag for the connection loop. Passed to extracted helper
 * functions so they can read/write shared state without closure nesting
 * (reduces Biome cognitive complexity).
 */
interface LoopState {
  userId: string
  hasConnected: boolean
  backoffIndex: number
  stopped: boolean
  fatalError: boolean
  reconnectTimeout: ReturnType<typeof setTimeout> | null
  heartbeatTimeout: ReturnType<typeof setTimeout> | null
  jwtRotationTimeout: ReturnType<typeof setTimeout> | null
  disconnectTimeout: ReturnType<typeof setTimeout> | null
  graceTimeout: ReturnType<typeof setTimeout> | null
  /** Per-attempt AbortController — aborted to trigger reconnect on heartbeat/JWT timeout. */
  attemptAbort: AbortController | null
  /** WHY: Distinguishes JWT rotation (zero events missed → skip invalidation)
   *  from heartbeat timeout (events may be missed → invalidate). */
  lastAbortReason: AbortReason | null
}

// ── Pure helpers (no closure state) ──────────────────────────────────

/**
 * Parses an SSE event and dispatches it on window as a CustomEvent.
 *
 * WHY extracted: Keeps the main hook under Biome's cognitive complexity limit.
 */
function parseAndDispatch(eventName: string, data: string) {
  if (!sseEventNameSet.has(eventName)) return

  let rawData: unknown
  try {
    rawData = JSON.parse(data) as unknown
  } catch {
    logger.warn('sse_invalid_json', { eventName, data })
    return
  }

  const parsed = serverEventSchema.safeParse(rawData)
  if (!parsed.success) {
    logger.warn('sse_validation_failed', {
      eventName,
      error: parsed.error.message,
    })
    return
  }

  // WHY: Dispatch to window so feature hooks (use-realtime-members, etc.)
  // can subscribe via useServerEvent(). This is the bridge between the
  // single SSE connection and N feature-specific handlers.
  window.dispatchEvent(new CustomEvent(`sse:${eventName}`, { detail: parsed.data }))
}

/**
 * Attempts a single SSE connection via fetch. Returns when the connection
 * closes (either by abort, network error, or non-2xx response).
 */
async function connectSSE(
  token: string,
  abortSignal: AbortSignal,
  onFirstData: () => void,
  onData: () => void,
): Promise<ConnectResult> {
  let response: Response
  try {
    response = await fetch(`${env.VITE_API_URL}/v1/events`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: abortSignal,
    })
  } catch {
    return { networkError: true }
  }

  if (response.status !== 200) {
    return { status: response.status }
  }

  if (response.body === null) {
    return { networkError: true }
  }

  let firstDataReceived = false

  const parser = createParser({
    onEvent(event: EventSourceMessage) {
      if (!firstDataReceived) {
        firstDataReceived = true
        onFirstData()
      }
      // WHY: Every event is proof the connection is alive — reset the
      // heartbeat timer so it only fires after true silence (45s).
      onData()
      if (event.event !== undefined && event.event.length > 0) {
        parseAndDispatch(event.event, event.data)
      }
    },
    onComment() {
      // WHY: Server sends `:heartbeat` comments every 30s. Treat any data
      // (including comments) as proof the connection is alive.
      if (!firstDataReceived) {
        firstDataReceived = true
        onFirstData()
      }
      onData()
    },
  })

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      parser.feed(value)
    }
  } catch {
    // WHY: reader.read() throws on abort or network disconnect.
    // Distinguish intentional aborts (JWT rotation, heartbeat timeout)
    // from unexpected disconnects so the caller can skip backoff.
    if (abortSignal.aborted) {
      return { aborted: true }
    }
  }

  return { status: 200 }
}

// ── Timer management (operates on LoopState) ────────────────────────

function clearAllTimers(s: LoopState) {
  if (s.reconnectTimeout !== null) clearTimeout(s.reconnectTimeout)
  if (s.heartbeatTimeout !== null) clearTimeout(s.heartbeatTimeout)
  if (s.jwtRotationTimeout !== null) clearTimeout(s.jwtRotationTimeout)
  if (s.disconnectTimeout !== null) clearTimeout(s.disconnectTimeout)
  if (s.graceTimeout !== null) clearTimeout(s.graceTimeout)
  s.reconnectTimeout = null
  s.heartbeatTimeout = null
  s.jwtRotationTimeout = null
  s.disconnectTimeout = null
  s.graceTimeout = null
}

function resetHeartbeat(s: LoopState) {
  if (s.heartbeatTimeout !== null) clearTimeout(s.heartbeatTimeout)
  s.heartbeatTimeout = setTimeout(() => {
    logger.warn('sse_heartbeat_timeout', { userId: s.userId })
    s.heartbeatTimeout = null
    s.lastAbortReason = 'heartbeat-timeout'
    s.attemptAbort?.abort()
  }, HEARTBEAT_TIMEOUT_MS)
}

function scheduleJwtRotation(s: LoopState) {
  if (s.jwtRotationTimeout !== null) clearTimeout(s.jwtRotationTimeout)
  s.jwtRotationTimeout = setTimeout(() => {
    logger.info('sse_jwt_rotation', { userId: s.userId })
    s.jwtRotationTimeout = null
    s.lastAbortReason = 'jwt-rotation'
    s.attemptAbort?.abort()
  }, MAX_CONNECTION_LIFETIME_MS)
}

function startDisconnectEscalation(s: LoopState) {
  if (s.disconnectTimeout !== null) return
  s.disconnectTimeout = setTimeout(() => {
    useConnectionStore.getState().setStatus('disconnected')
    s.disconnectTimeout = null
  }, DISCONNECT_ESCALATION_MS)
}

function setReconnectingWithGrace(s: LoopState) {
  if (s.graceTimeout !== null) return
  s.graceTimeout = setTimeout(() => {
    const current = useConnectionStore.getState().status
    if (current !== 'connected' && current !== 'disconnected') {
      useConnectionStore.getState().setStatus('reconnecting')
    }
    s.graceTimeout = null
  }, RECONNECT_GRACE_MS)
}

function clearReconnectTimers(s: LoopState) {
  if (s.disconnectTimeout !== null) {
    clearTimeout(s.disconnectTimeout)
    s.disconnectTimeout = null
  }
  if (s.graceTimeout !== null) {
    clearTimeout(s.graceTimeout)
    s.graceTimeout = null
  }
}

function clearStreamTimers(s: LoopState) {
  if (s.heartbeatTimeout !== null) {
    clearTimeout(s.heartbeatTimeout)
    s.heartbeatTimeout = null
  }
  if (s.jwtRotationTimeout !== null) {
    clearTimeout(s.jwtRotationTimeout)
    s.jwtRotationTimeout = null
  }
}

// ── Connection lifecycle helpers ─────────────────────────────────────

/**
 * Called when the first SSE data/comment arrives on a connection. Updates
 * connection status, invalidates queries on reconnect, and starts timers.
 */
function handleFirstData(s: LoopState, queryClient: { invalidateQueries: () => void }) {
  const reconnectReason = s.lastAbortReason
  s.lastAbortReason = null
  s.backoffIndex = 0

  if (s.hasConnected) {
    logger.info('sse_reconnected', { userId: s.userId, reason: reconnectReason })
    // WHY: JWT rotation reconnects miss zero events — the stream was
    // healthy until intentionally aborted. Invalidating the cache would
    // trigger a thundering herd of refetches for no reason. Only
    // invalidate on real disconnections where events may have been missed.
    if (reconnectReason !== 'jwt-rotation') {
      queryClient.invalidateQueries()
    }
  } else {
    logger.info('sse_connected', { userId: s.userId })
    s.hasConnected = true
  }

  clearReconnectTimers(s)
  useConnectionStore.getState().setStatus('connected')
  resetHeartbeat(s)
  scheduleJwtRotation(s)
}

/**
 * Handles the result of a connectSSE call. Returns 'continue' to retry,
 * 'backoff' to enter exponential backoff, or 'stop' to exit the loop.
 */
function handleConnectResult(result: ConnectResult, s: LoopState): 'continue' | 'backoff' | 'stop' {
  // WHY: Intentional abort (JWT rotation timer or heartbeat timeout) —
  // reconnect immediately with a fresh token, no backoff needed.
  if ('aborted' in result) {
    return 'continue'
  }

  if ('status' in result && result.status === 403) {
    s.fatalError = true
    logger.error('sse_forbidden', { userId: s.userId })
    useConnectionStore.getState().setStatus('disconnected', 'Email not verified')
    return 'stop'
  }

  if ('status' in result && result.status === 401) {
    // WHY: getSession() auto-refreshes expired access tokens, so a 401
    // means the refresh token is dead (long disconnect, or session revoked
    // server-side). Backoff to avoid hammering the server — Supabase's
    // background auto-refresh may still recover the session.
    logger.warn('sse_unauthorized', { userId: s.userId })
    if (s.hasConnected) setReconnectingWithGrace(s)
    startDisconnectEscalation(s)
    return 'backoff'
  }

  // WHY: Network error or non-401/403 HTTP error — enter backoff.
  if (s.hasConnected) setReconnectingWithGrace(s)
  startDisconnectEscalation(s)
  return 'backoff'
}

/** Waits for the exponential backoff delay. Resolves after the timeout. */
function waitBackoff(s: LoopState): Promise<void> {
  const delay = BACKOFF_DELAYS[Math.min(s.backoffIndex, BACKOFF_DELAYS.length - 1)]
  s.backoffIndex = s.backoffIndex + 1
  logger.warn('sse_backoff', { userId: s.userId, delay, attempt: s.backoffIndex })

  return new Promise<void>((resolve) => {
    s.reconnectTimeout = setTimeout(() => {
      s.reconnectTimeout = null
      resolve()
    }, delay)
  })
}

// ── React Hook ───────────────────────────────────────────────────────

/**
 * Opens a single fetch-based SSE connection to the Rust SSE endpoint.
 *
 * @param userId - Current authenticated user ID. When null, the connection is
 *   not opened. When it changes (logout -> login), the connection is torn down
 *   and re-established.
 * @param getToken - Async callback that returns a fresh Supabase JWT. Called
 *   before each connection attempt so tokens are never stale.
 */
export function useFetchSSE(
  userId: string | null,
  getToken: () => Promise<string | undefined>,
): void {
  const queryClient = useQueryClient()
  const reconnectKey = useConnectionStore((s) => s.reconnectKey)

  const getTokenRef = useRef(getToken)
  getTokenRef.current = getToken

  // WHY: Stable callback wrapper for the ref so the effect dependency
  // doesn't change when getToken's identity changes between renders.
  const getTokenStable = useCallback(async () => {
    return getTokenRef.current()
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: reconnectKey is an intentional trigger dependency — incrementing it via requestReconnect() forces this effect to re-run. getTokenStable is a stable ref-based wrapper that never changes identity.
  useEffect(() => {
    if (userId === null) return

    const outerAbort = new AbortController()

    const s: LoopState = {
      userId,
      hasConnected: false,
      backoffIndex: 0,
      stopped: false,
      fatalError: false,
      reconnectTimeout: null,
      heartbeatTimeout: null,
      jwtRotationTimeout: null,
      disconnectTimeout: null,
      graceTimeout: null,
      attemptAbort: null,
      lastAbortReason: null,
    }

    // WHY: Don't flash 'connecting' on token-rotation reconnects (triggered
    // via reconnectKey from AuthProvider's TOKEN_REFRESHED handler). If
    // already connected, stay connected until the new SSE handshake completes.
    if (!s.hasConnected && useConnectionStore.getState().status !== 'connected') {
      useConnectionStore.getState().setStatus('connecting')
    }

    runLoop(s, outerAbort, getTokenStable, queryClient)

    return () => {
      s.stopped = true
      clearAllTimers(s)
      outerAbort.abort()
      logger.info('sse_disconnected', { userId })
    }
  }, [userId, queryClient, reconnectKey, getTokenStable])
}

/**
 * Main connection loop — retries with exponential backoff until stopped.
 *
 * WHY extracted: Biome enforces max cognitive complexity of 15 per function.
 * The loop body delegates to handleConnectResult/waitBackoff/handleFirstData
 * to stay under the limit.
 */
async function runLoop(
  s: LoopState,
  outerAbort: AbortController,
  getToken: () => Promise<string | undefined>,
  queryClient: { invalidateQueries: () => void },
) {
  while (!s.stopped && !s.fatalError) {
    const token = await getToken()
    if (token === undefined || s.stopped) {
      logger.warn('sse_no_token', { userId: s.userId })
      useConnectionStore.getState().setStatus('disconnected')
      return
    }

    const attemptAbort = new AbortController()
    s.attemptAbort = attemptAbort

    function onOuterAbort() {
      attemptAbort.abort()
    }
    outerAbort.signal.addEventListener('abort', onOuterAbort, { once: true })

    const result = await connectSSE(
      token,
      attemptAbort.signal,
      () => handleFirstData(s, queryClient),
      () => resetHeartbeat(s),
    )

    outerAbort.signal.removeEventListener('abort', onOuterAbort)
    s.attemptAbort = null
    clearStreamTimers(s)

    if (s.stopped) return

    const action = handleConnectResult(result, s)

    if (action === 'stop') return

    if (action === 'backoff') {
      await waitBackoff(s)
      if (s.stopped) return
    }
  }
}
