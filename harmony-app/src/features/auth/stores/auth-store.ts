import type { Session, User } from '@supabase/supabase-js'
import { create } from 'zustand'

interface AuthState {
  session: Session | null
  user: User | null
  isLoading: boolean
  /** WHY: Surfaces desktop deep-link auth errors to DesktopLoginView. */
  desktopAuthError: string | null
  /** WHY: Set by PASSWORD_RECOVERY event to show the reset password screen. */
  isPasswordRecovery: boolean
  setSession: (session: Session | null) => void
  setUser: (user: User | null) => void
  setLoading: (isLoading: boolean) => void
  setDesktopAuthError: (error: string | null) => void
  setPasswordRecovery: (isPasswordRecovery: boolean) => void
  clear: () => void
}

export const useAuthStore = create<AuthState>()((set) => ({
  session: null,
  user: null,
  isLoading: true,
  desktopAuthError: null,
  isPasswordRecovery: false,
  setSession: (session) => set({ session }),
  setUser: (user) => set({ user }),
  setLoading: (isLoading) => set({ isLoading }),
  setDesktopAuthError: (desktopAuthError) => set({ desktopAuthError }),
  setPasswordRecovery: (isPasswordRecovery) => set({ isPasswordRecovery }),
  clear: () =>
    set({
      session: null,
      user: null,
      isLoading: false,
      desktopAuthError: null,
      isPasswordRecovery: false,
    }),
}))
