/**
 * Pure scroll-position math for the chat list's "stick to bottom" intent.
 * Extracted from chat-area.tsx so the at-bottom decision is unit-testable
 * without a DOM (same rationale as build-virtual-items.ts).
 */

/** Distance (px) from the bottom below which the list is considered "at bottom". */
export const STICK_TO_BOTTOM_THRESHOLD_PX = 200

export interface ScrollMetrics {
  scrollHeight: number
  scrollTop: number
  clientHeight: number
}

/** Pixels of unseen content below the viewport. */
export function distanceFromBottom(metrics: ScrollMetrics): number {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight
}

/**
 * True when the viewport is within `threshold` px of the bottom — the gate for
 * re-asserting scroll-to-bottom on new content. Height reservation (reserved
 * media boxes) keeps `scrollHeight` honest, so this stays reliable even while
 * off-screen rows are still estimate-sized.
 */
export function isNearBottom(
  metrics: ScrollMetrics,
  threshold: number = STICK_TO_BOTTOM_THRESHOLD_PX,
): boolean {
  return distanceFromBottom(metrics) < threshold
}
