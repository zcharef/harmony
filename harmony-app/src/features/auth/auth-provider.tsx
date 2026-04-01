import i18n from 'i18next'
import type { ReactNode } from 'react'
import { useEffect } from 'react'
import { syncProfile as syncProfileApi } from '@/lib/api'
import { useConnectionStore } from '@/lib/connection-store'
import { logger } from '@/lib/logger'
import { isTauri } from '@/lib/platform'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from './stores/auth-store'

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
  const { setSession, setUser, setLoading, clear } = useAuthStore()

  useEffect(() => {
    // WHY: getSession() returns a CACHED session from localStorage. Its JWT
    // may be stale (missing email claim after Supabase schema changes). We
    // only use it to restore UI state (session/user/loading). The actual
    // profile sync is a fire-and-forget side effect on SIGNED_IN/TOKEN_REFRESHED.
    supabase.auth
      .getSession()
      .then(({ data: { session } }) => {
        setSession(session)
        setUser(session?.user ?? null)
        setLoading(false)
      })
      .catch((err: unknown) => {
        logger.error('session_restore_failed', {
          error: err instanceof Error ? err.message : 'Unknown error',
        })
        setLoading(false)
      })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      setSession(session)
      setUser(session?.user ?? null)

      if (session === null) {
        clear()
        return
      }

      // WHY: Fire-and-forget profile sync to update metadata (display_name,
      // avatar_url) from OAuth providers. The DB trigger (Phase 1) handles
      // initial profile creation, so this is NOT on the critical path.
      // SSE connects independently based on userId — no sync gate needed.
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        syncProfileApi({ throwOnError: true }).catch((error: unknown) => {
          logger.error('profile_sync_failed', {
            error: error instanceof Error ? error.message : 'Unknown error',
          })
        })
      }

      // WHY: The SSE endpoint verifies the JWT once at connection time and
      // does NOT re-verify mid-stream. When Supabase refreshes the token,
      // we reconnect so the server sees the new JWT. This is silent — we
      // increment reconnectKey directly (not requestReconnect()) to avoid
      // flashing the "Reconnecting..." banner on routine token rotation.
      if (event === 'TOKEN_REFRESHED') {
        useConnectionStore.setState((s) => ({ reconnectKey: s.reconnectKey + 1 }))
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
  }, [setSession, setUser, setLoading, clear])

  return children
}
