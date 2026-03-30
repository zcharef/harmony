import { create } from 'zustand'

interface UnreadStore {
  counts: Record<string, number>
  /** Increment unread count for a channel (called on SSE message.created for non-active channels). */
  increment: (channelId: string) => void
  /** Clear unread count for a channel (called when user focuses that channel). */
  clear: (channelId: string) => void
  /** Initialize counts from server response (called on server load). */
  initFromServer: (states: ReadonlyArray<{ channelId: string; unreadCount: number }>) => void
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
  initFromServer: (states) =>
    set({
      counts: Object.fromEntries(states.map((s) => [s.channelId, s.unreadCount])),
    }),
}))
