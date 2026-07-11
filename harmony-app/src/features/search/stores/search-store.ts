import { create } from 'zustand'

/**
 * Global search-overlay state (spec §5.2). A tiny store bridges the two entry
 * points — the channel toolbar (in-channel) and the server sidebar
 * (server-wide) — to the single overlay mounted in MainLayout, without
 * threading callbacks through unrelated component trees.
 */

/** The channel the overlay is pre-scoped to. `null` scope = server-wide search. */
export interface SearchScope {
  channelId: string
  channelName: string
  /** Encrypted channels are un-searchable server-side — the overlay says so. */
  encrypted: boolean
}

interface SearchStore {
  isOpen: boolean
  scope: SearchScope | null
  /** Open pre-scoped to a channel (`in:#current`). */
  openInChannel: (scope: SearchScope) => void
  /** Open with no channel scope (whole server). */
  openServerWide: () => void
  close: () => void
}

export const useSearchStore = create<SearchStore>((set) => ({
  isOpen: false,
  scope: null,
  openInChannel: (scope) => set({ isOpen: true, scope }),
  openServerWide: () => set({ isOpen: true, scope: null }),
  // WHY reset scope on close: leaving a stale scope readable while closed is a
  // state-hygiene hazard for any future subscriber.
  close: () => set({ isOpen: false, scope: null }),
}))
