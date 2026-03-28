import { create } from 'zustand'

import type { UserStatus } from '@/lib/api'

interface PresenceState {
  presenceMap: Map<string, UserStatus>
  setUserStatus: (userId: string, status: UserStatus) => void
  syncPresenceState: (map: Map<string, UserStatus>) => void
  removeUser: (userId: string) => void
  clearAll: () => void
}

export const usePresenceStore = create<PresenceState>()((set) => ({
  presenceMap: new Map(),
  setUserStatus: (userId, status) =>
    set((state) => {
      const next = new Map(state.presenceMap)
      next.set(userId, status)
      return { presenceMap: next }
    }),
  syncPresenceState: (map) => set({ presenceMap: map }),
  removeUser: (userId) =>
    set((state) => {
      const next = new Map(state.presenceMap)
      next.delete(userId)
      return { presenceMap: next }
    }),
  clearAll: () => set({ presenceMap: new Map() }),
}))

/** Selector hook for a single user's status. Defaults to `'offline'`. */
export function useUserStatus(userId: string): UserStatus {
  return usePresenceStore((state) => state.presenceMap.get(userId) ?? 'offline')
}
