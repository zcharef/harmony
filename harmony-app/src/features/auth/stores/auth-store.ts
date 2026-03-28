import type { Session, User } from '@supabase/supabase-js'
import { create } from 'zustand'

interface AuthState {
  session: Session | null
  user: User | null
  isLoading: boolean
  /** WHY: Surfaces profile sync errors (e.g., "username taken") to the UI. */
  profileSyncError: string | null
  setSession: (session: Session | null) => void
  setUser: (user: User | null) => void
  setLoading: (isLoading: boolean) => void
  setProfileSyncError: (error: string | null) => void
  clear: () => void
}

export const useAuthStore = create<AuthState>()((set) => ({
  session: null,
  user: null,
  isLoading: true,
  profileSyncError: null,
  setSession: (session) => set({ session }),
  setUser: (user) => set({ user }),
  setLoading: (isLoading) => set({ isLoading }),
  setProfileSyncError: (profileSyncError) => set({ profileSyncError }),
  clear: () => set({ session: null, user: null, isLoading: false, profileSyncError: null }),
}))
