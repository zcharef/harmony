import { create } from 'zustand'

/**
 * Member-list panel visibility. A tiny store bridges the channel toolbar's
 * "people" button to the MemberList <Panel> mounted in MainLayout, without
 * threading callbacks through unrelated component trees (same pattern as
 * useSearchStore).
 */
interface MemberListStore {
  /** WHY default true: the members panel is shown by default in server view;
   * the toggle only hides it. Defaulting false would regress the layout. */
  isOpen: boolean
  toggle: () => void
}

export const useMemberListStore = create<MemberListStore>((set) => ({
  isOpen: true,
  toggle: () => set((state) => ({ isOpen: state.isOpen === false })),
}))
