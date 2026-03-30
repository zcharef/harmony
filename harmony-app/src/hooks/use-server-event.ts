import { useEffect, useRef } from 'react'

/**
 * WHY: Thin contract between useEventSource (SSE connection manager) and
 * feature-specific realtime hooks. useEventSource dispatches CustomEvents
 * on `window` keyed by SSE event name (e.g. "member.joined"). Feature hooks
 * register handlers via this hook.
 *
 * Using window CustomEvents is the simplest possible bus — no Zustand store,
 * no EventTarget instance to share, no context provider. The SSE event names
 * are already unique strings from the Rust API (server_event.rs:event_name()).
 *
 * The CustomEvent.detail carries the parsed JSON payload from the SSE `data:` field.
 */

/** Prefix for all SSE-dispatched events to avoid collisions with browser events. */
export const SSE_EVENT_PREFIX = 'sse:' as const

/**
 * Subscribes to a specific SSE event type dispatched on `window`.
 *
 * @param eventType - The SSE event name (e.g. "member.joined"). Pass null to skip subscription.
 * @param handler - Called with the raw payload (`unknown`). Callers are responsible
 *   for Zod validation before narrowing the type (CLAUDE.md §1.2). The previous
 *   generic `<T>` was removed because `e.detail` is always `any` from CustomEvent —
 *   the generic provided no runtime guarantee and every caller already validates.
 */
export function useServerEvent(eventType: string | null, handler: (payload: unknown) => void) {
  // WHY: Ref avoids re-subscribing when handler changes. Follows the same
  // pattern as handlersRef in use-event-source.ts:47-48. Without this, every
  // render that produces a new handler reference tears down and re-adds the
  // event listener, causing subscription churn.
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  useEffect(() => {
    if (eventType === null) return

    const fullEventName = `${SSE_EVENT_PREFIX}${eventType}`

    function onEvent(e: Event) {
      if (!(e instanceof CustomEvent)) return
      handlerRef.current(e.detail)
    }

    window.addEventListener(fullEventName, onEvent)
    return () => {
      window.removeEventListener(fullEventName, onEvent)
    }
  }, [eventType])
}
