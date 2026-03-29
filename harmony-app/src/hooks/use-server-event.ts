import { useEffect } from 'react'

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
 * @param handler - Called with the parsed JSON payload when the event fires.
 */
export function useServerEvent<T = unknown>(
  eventType: string | null,
  handler: (payload: T) => void,
) {
  useEffect(() => {
    if (eventType === null) return

    const fullEventName = `${SSE_EVENT_PREFIX}${eventType}`

    function onEvent(e: Event) {
      if (!(e instanceof CustomEvent)) return
      handler(e.detail)
    }

    window.addEventListener(fullEventName, onEvent)
    return () => {
      window.removeEventListener(fullEventName, onEvent)
    }
  }, [eventType, handler])
}
