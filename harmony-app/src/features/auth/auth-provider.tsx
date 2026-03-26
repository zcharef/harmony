import type { ReactNode } from 'react'
import { useEffect, useRef } from 'react'
import { env } from '@/lib/env'
import { logger } from '@/lib/logger'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from './stores/auth-store'

/**
 * WHY: After login, we notify the backend so it can upsert the user profile
 * (display_name, avatar_url, etc.) from the Supabase auth metadata.
 *
 * Returns the error detail string on failure, or null on success.
 *
 * TODO: Replace this raw fetch with the generated API client once the
 * POST /v1/auth/me endpoint is added to the OpenAPI spec and `just gen-api` is run.
 */
async function syncProfile(
  accessToken: string,
  isSyncing: React.RefObject<boolean>,
): Promise<string | null> {
  // WHY: Guard against duplicate sync calls from rapid auth events
  if (isSyncing.current) {
    return null
  }
  isSyncing.current = true

  try {
    const response = await fetch(`${env.VITE_API_URL}/v1/auth/me`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    })

    if (!response.ok) {
      // WHY: Parse RFC 9457 ProblemDetails body for actionable error detail.
      let detail = 'Profile sync failed'
      try {
        const body: unknown = await response.json()
        if (
          typeof body === 'object' &&
          body !== null &&
          'detail' in body &&
          typeof (body as { detail: unknown }).detail === 'string'
        ) {
          detail = (body as { detail: string }).detail
        }
      } catch {
        // WHY: Response may not be JSON (e.g., 502 from proxy). Use generic message.
      }

      logger.error('profile_sync_failed', {
        status: response.status,
        detail,
      })

      return detail
    }

    return null
  } catch (error: unknown) {
    // WHY: Network failures (DNS, CORS, offline) throw instead of returning a response.
    const message = error instanceof Error ? error.message : 'Network error'
    logger.error('profile_sync_network_error', { error: message })
    return message
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
  const { setSession, setUser, setLoading, setProfileSyncError, clear } = useAuthStore()
  const isSyncing = useRef(false)

  useEffect(() => {
    // WHY: getSession() reads the locally stored session (from cookies/localStorage).
    // This avoids a network call on every page load while still rehydrating auth state.
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      setUser(session?.user ?? null)
      setLoading(false)

      if (session !== null) {
        syncProfile(session.access_token, isSyncing).then((error) => {
          if (error !== null) {
            setProfileSyncError(error)
          }
        })
      }
    })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
      setUser(session?.user ?? null)
      setProfileSyncError(null)

      if (session !== null) {
        syncProfile(session.access_token, isSyncing).then((error) => {
          if (error !== null) {
            setProfileSyncError(error)
          }
        })
      } else {
        clear()
      }
    })

    return () => {
      subscription.unsubscribe()
    }
  }, [setSession, setUser, setLoading, setProfileSyncError, clear])

  return children
}
