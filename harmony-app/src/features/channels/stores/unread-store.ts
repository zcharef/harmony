import { create } from 'zustand'

interface UnreadStore {
  counts: Record<string, number>
  /** Increment unread count for a channel (SSE message.created delta). */
  increment: (channelId: string) => void
  /** Clear unread count for a channel (user views or mark-as-read). */
  clear: (channelId: string) => void
  /**
   * Replace entire counts with authoritative server snapshot (SSE unread.sync).
   * WHY full replace: the server snapshot is the source of truth on connect/reconnect.
   * Ordering is safe because initial_stream.chain() guarantees unread.sync arrives
   * before any message.created deltas.
   */
  sync: (channels: Record<string, number>) => void
}

export const useUnreadStore = create<UnreadStore>((set) => ({
  counts: {},
  increment: (channelId) =>
    set((s) => ({
      counts: { ...s.counts, [channelId]: (s.counts[channelId] ?? 0) + 1 },
    })),
  clear: (channelId) =>
    set((s) => ({
      counts: { ...s.counts, [channelId]: 0 },
    })),
  sync: (channels) => set({ counts: channels }),
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
