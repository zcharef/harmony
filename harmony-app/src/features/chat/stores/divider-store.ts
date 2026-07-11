import { create } from 'zustand'

/**
 * Frozen "new messages" divider anchor, keyed by channelId (unread-divider
 * ticket §5.3).
 *
 * WHY a store (not derived state): the anchor is captured ONCE on channel open
 * and MUST survive the `mark-read` mutation that fires on focus — deriving it
 * from the live unread store or a refetch would erase the divider as soon as
 * the channel is read. It is ephemeral per-view state, so Zustand (mirroring
 * `unread-store`) is the right home, not the server.
 */
interface DividerStore {
  /** ISO timestamp of the frozen boundary; `null` = never read. Absent = not yet frozen. */
  anchors: Record<string, { anchorAt: string | null } | undefined>
  /**
   * Freeze the anchor for a channel. Idempotent per channelId — a no-op once an
   * anchor exists, so a re-resolving read-state query never overwrites it.
   */
  freeze: (channelId: string, anchorAt: string | null) => void
  /** Drop the anchor on channel switch so re-entry re-freezes a fresh boundary. */
  clear: (channelId: string) => void
}

export const useDividerStore = create<DividerStore>((set) => ({
  anchors: {},
  freeze: (channelId, anchorAt) =>
    set((s) => {
      if (s.anchors[channelId] !== undefined) return s
      return { anchors: { ...s.anchors, [channelId]: { anchorAt } } }
    }),
  clear: (channelId) =>
    set((s) => {
      if (s.anchors[channelId] === undefined) return s
      const next = { ...s.anchors }
      delete next[channelId]
      return { anchors: next }
    }),
}))
