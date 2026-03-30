import type { Session, User } from '@supabase/supabase-js'
import { create } from 'zustand'

interface AuthState {
  session: Session | null
  user: User | null
  isLoading: boolean
  /** WHY: Surfaces profile sync errors (e.g., "username taken") to the UI. */
  profileSyncError: string | null
  /** WHY: Surfaces desktop deep-link auth errors to DesktopLoginView. */
  desktopAuthError: string | null
  /** WHY: Gates EventSource creation on profile sync completion so the HMAC
   *  session cookie is set before the first SSE request (prevents 401 race). */
  isProfileSynced: boolean
  setSession: (session: Session | null) => void
  setUser: (user: User | null) => void
  setLoading: (isLoading: boolean) => void
  setProfileSyncError: (error: string | null) => void
  setDesktopAuthError: (error: string | null) => void
  setProfileSynced: (synced: boolean) => void
  clear: () => void
}

export const useAuthStore = create<AuthState>()((set) => ({
  session: null,
  user: null,
  isLoading: true,
  profileSyncError: null,
  desktopAuthError: null,
  isProfileSynced: false,
  setSession: (session) => set({ session }),
  setUser: (user) => set({ user }),
  setLoading: (isLoading) => set({ isLoading }),
  setProfileSyncError: (profileSyncError) => set({ profileSyncError }),
  setDesktopAuthError: (desktopAuthError) => set({ desktopAuthError }),
  setProfileSynced: (isProfileSynced) => set({ isProfileSynced }),
  clear: () =>
    set({
      session: null,
      user: null,
      isLoading: false,
      profileSyncError: null,
      desktopAuthError: null,
      isProfileSynced: false,
    }),
}))
