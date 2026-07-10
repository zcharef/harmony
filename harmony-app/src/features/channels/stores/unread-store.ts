import { create } from 'zustand'

interface UnreadStore {
  counts: Record<string, number>
  /**
   * Per-channel mention counts (mention-equivalent messages, spec §1).
   * WHY same store: one pattern per concern — mentions are a strict subset
   * of unreads and share the same lifecycle (increment / clear / sync).
   */
  mentionCounts: Record<string, number>
  /** Increment unread count for a channel (SSE message.created delta). */
  increment: (channelId: string) => void
  /** Increment mention count for a channel (SSE mention.received / DM message delta). */
  incrementMention: (channelId: string) => void
  /** Clear BOTH counts for a channel (user views or mark-as-read). */
  clear: (channelId: string) => void
  /**
   * Replace entire counts with authoritative server snapshot (SSE unread.sync).
   * WHY full replace: the server snapshot is the source of truth on connect/reconnect.
   * Ordering is safe because initial_stream.chain() guarantees unread.sync arrives
   * before any message.created deltas.
   * WHY optional mentions: older API instances omit the map during rollout.
   */
  sync: (channels: Record<string, number>, mentions?: Record<string, number>) => void
}

export const useUnreadStore = create<UnreadStore>((set) => ({
  counts: {},
  mentionCounts: {},
  increment: (channelId) =>
    set((s) => ({
      counts: { ...s.counts, [channelId]: (s.counts[channelId] ?? 0) + 1 },
    })),
  incrementMention: (channelId) =>
    set((s) => ({
      mentionCounts: { ...s.mentionCounts, [channelId]: (s.mentionCounts[channelId] ?? 0) + 1 },
    })),
  clear: (channelId) =>
    set((s) => ({
      counts: { ...s.counts, [channelId]: 0 },
      mentionCounts: { ...s.mentionCounts, [channelId]: 0 },
    })),
  sync: (channels, mentions) => set({ counts: channels, mentionCounts: mentions ?? {} }),
}))

/**
 * Derived selector: total unread count across all channels.
 *
 * WHY: Badge hooks (document title, favicon, dock badge) all need the total.
 * Returns a number primitive so Zustand skips re-renders when the sum is unchanged.
 */
export function useTotalUnread(): number {
  return useUnreadStore((s) => Object.values(s.counts).reduce((sum, count) => sum + count, 0))
}

/**
 * Derived selector: total mention count across all channels.
 * Mirrors useTotalUnread — drives the `(@N)` document title (spec §1).
 */
export function useTotalMentions(): number {
  return useUnreadStore((s) =>
    Object.values(s.mentionCounts).reduce((sum, count) => sum + count, 0),
  )
}
