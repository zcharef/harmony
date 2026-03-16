import type { ReactNode } from 'react'
import { useEffect, useRef } from 'react'
import { env } from '@/lib/env'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from './stores/auth-store'

/**
 * WHY: After login, we notify the backend so it can upsert the user profile
 * (display_name, avatar_url, etc.) from the Supabase auth metadata.
 *
 * TODO: Replace this raw fetch with the generated API client once the
 * POST /v1/auth/me endpoint is added to the OpenAPI spec and `just gen-api` is run.
 */
async function syncProfile(accessToken: string, isSyncing: React.RefObject<boolean>) {
  // WHY: Guard against duplicate sync calls from rapid auth events
  if (isSyncing.current) {
    return
  }
  isSyncing.current = true

  try {
    await fetch(`${env.VITE_API_URL}/v1/auth/me`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    })
  } finally {
    isSyncing.current = false
  }
}

/**
 * WHY: Centralized auth lifecycle management. Initializes session on mount,
 * subscribes to auth state changes, and syncs the user profile with the backend.
 * Must wrap the entire app to ensure auth state is available everywhere.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const { setSession, setUser, setLoading, clear } = useAuthStore()
  const isSyncing = useRef(false)

  useEffect(() => {
    // WHY: getSession() reads the locally stored session (from cookies/localStorage).
    // This avoids a network call on every page load while still rehydrating auth state.
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      setUser(session?.user ?? null)
      setLoading(false)

      if (session !== null) {
        syncProfile(session.access_token, isSyncing)
      }
    })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
      setUser(session?.user ?? null)

      if (session !== null) {
        syncProfile(session.access_token, isSyncing)
      } else {
        clear()
      }
    })

    return () => {
      subscription.unsubscribe()
    }
  }, [setSession, setUser, setLoading, clear])

  return children
}
