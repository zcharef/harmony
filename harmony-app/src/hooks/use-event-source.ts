/**
 * SSE connection hook — single EventSource for all real-time events.
 *
 * WHY: Replaces Supabase Realtime with a Rust SSE endpoint (`GET /v1/events`).
 * The browser's native EventSource handles auto-reconnect. On reconnect
 * (onopen after an error), all TanStack Query caches are invalidated so the
 * UI catches up with any events missed during the disconnect (ADR-SSE-006).
 *
 * Pattern reference: use-realtime-messages.ts (useEffect + useQueryClient),
 * use-presence.ts (useEffect lifecycle with cleanup).
 *
 * Called once in MainLayout, gated on auth state.
 */

import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'

import { env } from '@/lib/env'
import {
  type ServerEventHandlers,
  SSE_EVENT_NAME_TO_TYPE,
  SSE_EVENT_NAMES,
  type SseEventName,
  serverEventSchema,
} from '@/lib/event-types'
import { logger } from '@/lib/logger'

/**
 * Opens a single EventSource connection to the Rust SSE endpoint.
 *
 * @param handlers - Map of event type → handler. Features register handlers
 *   for the event types they care about. The hook dispatches parsed + validated
 *   events to the matching handler.
 * @param userId - Current authenticated user ID. When null, the connection is
 *   not opened. When it changes (logout → login), the connection is torn down
 *   and re-established.
 */
export function useEventSource(handlers: ServerEventHandlers, userId: string | null): void {
  const queryClient = useQueryClient()
  // WHY: Ref avoids re-creating the EventSource when handlers change.
  // Handlers are typically new objects each render (inline object literal),
  // but the actual function references are stable via useCallback in features.
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers

  // WHY: Track whether we have had a successful connection at least once.
  // On the *first* open we do NOT invalidate queries (data is already fresh
  // from the initial page load). Only on re-opens after an error do we
  // invalidate to catch up on missed events.
  const hasConnectedRef = useRef(false)

  useEffect(() => {
    if (userId === null) return

    const url = `${env.VITE_API_URL}/v1/events`

    // WHY: withCredentials sends the session cookie for auth (ADR-SSE-005).
    const es = new EventSource(url, { withCredentials: true })

    es.onopen = () => {
      if (hasConnectedRef.current) {
        // WHY: This is a reconnect — invalidate all queries to catch up on
        // events missed during the disconnect (ADR-SSE-006).
        logger.info('sse_reconnected', { userId })
        queryClient.invalidateQueries()
      } else {
        logger.info('sse_connected', { userId })
        hasConnectedRef.current = true
      }
    }

    es.onerror = () => {
      // WHY: EventSource fires onerror for both transient network hiccups
      // and fatal errors. The browser auto-reconnects for transient errors.
      // We log at warn level because this is a background operation — no user
      // feedback needed (ADR-045: background ops fail silently).
      logger.warn('sse_connection_error', { userId })
    }

    // ── Register a listener for each SSE event name ──────────────
    // WHY: The SSE `event:` field uses dot-separated names ("message.created").
    // EventSource dispatches named events via addEventListener, not onmessage.
    // onmessage only fires for events without an `event:` field.

    // WHY extracted: Biome enforces max cognitive complexity of 15 per function.
    // Parsing + validation is extracted so the listener stays under the limit.
    function parseAndDispatch(eventName: SseEventName, data: string) {
      const rawData: unknown = (() => {
        try {
          return JSON.parse(data) as unknown
        } catch {
          logger.warn('sse_invalid_json', { eventName, data })
          return undefined
        }
      })()

      if (rawData === undefined) return

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

      const eventType = SSE_EVENT_NAME_TO_TYPE[eventName]
      const handler = handlersRef.current[eventType]
      if (handler !== undefined) {
        handler(parsed.data)
      }
    }

    function createListener(eventName: SseEventName) {
      return (e: Event) => {
        // WHY: instanceof narrows Event → MessageEvent safely (no `as Type`).
        // SSE named events always deliver MessageEvent objects.
        if (!(e instanceof MessageEvent)) return
        parseAndDispatch(eventName, String(e.data))
      }
    }

    const listeners = SSE_EVENT_NAMES.map((eventName) => {
      const listener = createListener(eventName)
      es.addEventListener(eventName, listener)
      return { eventName, listener }
    })

    return () => {
      // WHY: Remove all listeners before closing to prevent firing during close.
      for (const { eventName, listener } of listeners) {
        es.removeEventListener(eventName, listener)
      }
      es.close()
      // WHY: Reset so the next connection (re-login) treats its first
      // onopen as a fresh connect, not a reconnect that triggers invalidation.
      hasConnectedRef.current = false
      logger.info('sse_disconnected', { userId })
    }
  }, [userId, queryClient])
}
