import i18n from 'i18next'
import type { ReactNode } from 'react'
import { useEffect, useRef } from 'react'
import { syncProfile as syncProfileApi } from '@/lib/api'
import { logger } from '@/lib/logger'
import { isTauri } from '@/lib/platform'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from './stores/auth-store'

/**
 * Serialized profile sync — deduplicates concurrent calls by queuing.
 *
 * WHY: On page load, getSession() and onAuthStateChange fire near-simultaneously.
 * The first call may fail (stale JWT missing email claim → 400). With a simple
 * boolean guard, the second call was skipped entirely — leaving isProfileSynced
 * false and the SSE connection never established.
 *
 * This queue ensures the second call WAITS for the first to finish, then runs
 * with the (now-refreshed) Supabase token. No arbitrary timeouts, no dropped calls.
 *
 * Returns error detail string on failure, null on success.
 */
function createProfileSyncer() {
  let inFlight: Promise<string | null> | null = null
  let queued = false

  async function doSync(): Promise<string | null> {
    try {
      await syncProfileApi({
        credentials: 'include',
        throwOnError: true,
      })
      return null
    } catch (error: unknown) {
      let message = 'Profile sync failed'
      if (error instanceof Error) {
        message = error.message
      } else if (
        typeof error === 'object' &&
        error !== null &&
        'detail' in error &&
        typeof error.detail === 'string'
      ) {
        message = error.detail
      }
      logger.error('profile_sync_failed', { error: message })
      return message
    }
  }

  return async function syncProfile(): Promise<string | null> {
    // WHY: If a sync is already in-flight, queue ONE follow-up call instead of
    // skipping. When the in-flight call finishes, the queued call runs with the
    // latest Supabase token (which may have been refreshed during the wait).
    if (inFlight !== null) {
      queued = true
      await inFlight
      // WHY: Only the last queued caller needs to execute — intermediate ones
      // can piggyback on the result. Check if we're still the queued one.
      if (!queued) return null
    }

    queued = false
    inFlight = doSync()
    const result = await inFlight
    inFlight = null
    return result
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
    useAuthStore.getState().setDesktopAuthError(i18n.t('auth:securityValidationError'))
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
  const { setSession, setUser, setLoading, setProfileSyncError, setProfileSynced, clear } =
    useAuthStore()
  // WHY: useRef so the syncer instance survives re-renders without recreating.
  const syncerRef = useRef(createProfileSyncer())
  const syncProfile = syncerRef.current

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
          syncProfile().then((result) => {
            if (result === null) {
              setProfileSynced(true)
            } else {
              setProfileSyncError(result)
              // WHY: The initial getSession() may return a stale JWT missing the
              // email claim (400 error). Meanwhile, onAuthStateChange fires and
              // gets 'skipped' because isSyncing is still true. After the first
              // call fails and releases the lock, no retry happens — leaving
              // isProfileSynced=false and the SSE connection never established.
              // Retry once after a brief delay to use the refreshed token.
              setTimeout(() => {
                syncProfile(isSyncing).then((retryResult) => {
                  if (retryResult === null) {
                    setProfileSynced(true)
                    setProfileSyncError(null)
                  }
                })
              }, 1_000)
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
        syncProfile().then((result) => {
          if (result === null) {
            setProfileSynced(true)
          } else {
            setProfileSyncError(result)
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
  }, [setSession, setUser, setLoading, setProfileSyncError, setProfileSynced, clear, syncProfile])

  return children
}
