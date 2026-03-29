import type { ReactNode } from 'react'
import { useEffect, useRef } from 'react'
import { syncProfile as syncProfileApi } from '@/lib/api'
import { logger } from '@/lib/logger'
import { isTauri } from '@/lib/platform'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from './stores/auth-store'

/**
 * WHY: After login, we notify the backend so it can upsert the user profile
 * (display_name, avatar_url, etc.) from the Supabase auth metadata.
 *
 * Returns the error detail string on failure, or null on success.
 */
async function syncProfile(
  isSyncing: React.RefObject<boolean>,
): Promise<string | null> {
  // WHY: Guard against duplicate sync calls from rapid auth events
  if (isSyncing.current) {
    return null
  }
  isSyncing.current = true

  try {
    await syncProfileApi({
      // WHY: `credentials: 'include'` is required for the browser to store the
      // `Set-Cookie` header from a cross-origin response. Without it, the session
      // cookie is returned by the server but silently discarded, so EventSource
      // (which cannot send Authorization headers) can never authenticate (ADR-SSE-005).
      credentials: 'include',
      throwOnError: true,
    })
    return null
  } catch (error: unknown) {
    // WHY: SDK throws ProblemDetails (RFC 9457) for 4xx/5xx, or Error for network failures.
    let message = 'Profile sync failed'
    if (error instanceof Error) {
      message = error.message
    } else if (typeof error === 'object' && error !== null && 'detail' in error && typeof error.detail === 'string') {
      message = error.detail
    }
    logger.error('profile_sync_failed', { error: message })
    return message
  } finally {
    isSyncing.current = false
  }
}

/**
 * WHY extracted: Handles the deep link auth callback from the system browser.
 * Validates the PKCE state, exchanges the one-time code for tokens, and
 * sets the Supabase session. Extracted to keep AuthProvider below Biome's
 * cognitive complexity limit.
 */
async function handleDeepLinkCallback({ code, state }: { code: string; state: string }) {
  const expectedState = localStorage.getItem('desktop_auth_state')
  const codeVerifier = localStorage.getItem('desktop_auth_code_verifier')

  // WHY: Validate state nonce to prevent CSRF — reject callbacks
  // that don't match the state we generated before opening the browser.
  if (state !== expectedState || codeVerifier === null) {
    logger.error('desktop_auth_state_mismatch', {
      expected: expectedState,
      received: state,
    })
    useAuthStore
      .getState()
      .setDesktopAuthError('Authentication failed: security validation error. Please try again.')
    return
  }

  // WHY: Clean up PKCE state — single use.
  localStorage.removeItem('desktop_auth_state')
  localStorage.removeItem('desktop_auth_code_verifier')

  try {
    const { redeemAuthCode } = await import('@/lib/desktop-auth')
    const { accessToken, refreshToken } = await redeemAuthCode(code, codeVerifier)

    await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    logger.error('desktop_auth_redeem_failed', { error: message })
    useAuthStore.getState().setDesktopAuthError(message)
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
    supabase.auth
      .getSession()
      .then(({ data: { session } }) => {
        setSession(session)
        setUser(session?.user ?? null)
        setLoading(false)

        if (session !== null) {
          syncProfile(isSyncing).then((error) => {
            if (error !== null) {
              setProfileSyncError(error)
            }
          })
        }
      })
      .catch((err: unknown) => {
        logger.error('session_restore_failed', {
          error: err instanceof Error ? err.message : 'Unknown error',
        })
        setLoading(false)
      })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
      setUser(session?.user ?? null)
      setProfileSyncError(null)

      if (session !== null) {
        syncProfile(isSyncing).then((error) => {
          if (error !== null) {
            setProfileSyncError(error)
          }
        })
      } else {
        clear()
      }
    })

    // WHY: In Tauri, listen for deep link auth callbacks. The desktop login
    // flow opens the system browser, which redirects back via harmony://auth/callback
    // with a one-time auth code. We exchange it for real tokens via PKCE.
    let unlistenDeepLink: (() => void) | undefined
    let deepLinkCancelled = false
    if (isTauri()) {
      import('@/lib/desktop-auth')
        .then(({ listenForAuthCallback }) => {
          listenForAuthCallback(handleDeepLinkCallback).then((unlisten) => {
            if (deepLinkCancelled) {
              unlisten()
            } else {
              unlistenDeepLink = unlisten
            }
          })
        })
        .catch((err: unknown) => {
          logger.error('desktop_auth_listener_setup_failed', {
            error: err instanceof Error ? err.message : 'Unknown error',
          })
        })
    }

    return () => {
      deepLinkCancelled = true
      subscription.unsubscribe()
      unlistenDeepLink?.()
    }
  }, [setSession, setUser, setLoading, setProfileSyncError, clear])

  return children
}
