/**
 * Prefix for optimistic (not-yet-persisted) message IDs.
 *
 * WHY a standalone, React-free module: both the send hook (use-send-message)
 * and pure list-shaping logic (build-virtual-items) must agree on this prefix —
 * one to mint optimistic IDs, the other to skip them when placing the "new
 * messages" divider. Keeping it here lets the pure module import it without
 * dragging React deps in.
 */
export const OPTIMISTIC_ID_PREFIX = 'temp-'
