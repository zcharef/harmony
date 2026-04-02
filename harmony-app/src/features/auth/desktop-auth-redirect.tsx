/**
 * Desktop auth redirect — handles the case where the user is already
 * logged in on the web when they arrive with ?redirect_scheme=harmony.
 *
 * WHY: When Tauri opens the browser for auth, the user might already
 * have an active web session. Instead of showing the main app, we show
 * a confirmation screen and redirect back to the desktop app.
 */

import { Button, Card, CardBody, CardHeader, Chip, Spinner } from '@heroui/react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { createDesktopAuthCode } from '@/lib/api'
import { logger } from '@/lib/logger'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from './stores/auth-store'

type RedirectStatus = 'confirm' | 'redirecting' | 'done' | 'error'

export function DesktopAuthRedirect() {
  const { t } = useTranslation('auth')
  const { user } = useAuthStore()
  const [status, setStatus] = useState<RedirectStatus>('confirm')
  const [error, setError] = useState<string | null>(null)

  const params = new URLSearchParams(window.location.search)
  const codeChallenge = params.get('code_challenge')
  const state = params.get('state')

  async function handleContinue() {
    setStatus('redirecting')

    try {
      const { data: sessionData } = await supabase.auth.getSession()
      const session = sessionData.session
      if (session === null || codeChallenge === null || state === null) {
        throw new Error('Missing session or PKCE params')
      }

      const { data } = await createDesktopAuthCode({
        body: {
          codeChallenge,
          refreshToken: session.refresh_token,
        },
        throwOnError: true,
      })

      // WHY: Set status to 'done' BEFORE the redirect so the user sees
      // "You can close this tab" instead of a spinner if the page remains visible.
      setStatus('done')
      window.location.href = `harmony://auth/callback?code=${encodeURIComponent(data.authCode)}&state=${encodeURIComponent(state)}`
    } catch (err: unknown) {
      logger.error('desktop_auth_redirect_failed', {
        error: err instanceof Error ? err.message : 'Unknown error',
      })
      setError(err instanceof Error ? err.message : t('desktopLoginError'))
      setStatus('error')
    }
  }

  async function handleDifferentAccount() {
    try {
      await supabase.auth.signOut()
      // WHY: After sign out, the AuthProvider will clear the session,
      // App.tsx will render LoginPage, and the redirect_scheme params
      // persist in the URL — so the normal login + redirect flow kicks in.
    } catch (err: unknown) {
      logger.error('desktop_auth_signout_failed', {
        error: err instanceof Error ? err.message : 'Unknown error',
      })
      setError(err instanceof Error ? err.message : t('desktopLoginError'))
      setStatus('error')
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="flex flex-col items-center gap-2 pb-0 pt-6">
          <img src="/brand/logo_vertical_dark.png" alt="Harmony" className="h-24 w-auto" />
          <Chip color="secondary" size="sm" variant="dot">
            {t('alphaLabel', { ns: 'common' })}
          </Chip>
        </CardHeader>

        <CardBody className="gap-4 px-6 pb-6">
          {status === 'confirm' && (
            <div className="flex flex-col items-center gap-4">
              <p className="text-center text-sm text-default-500">
                {t('desktopRedirectConfirm')} <strong>{user?.email}</strong>?
              </p>
              <Button
                data-test="desktop-redirect-continue"
                color="primary"
                className="w-full"
                onPress={handleContinue}
              >
                {t('desktopRedirectContinue')}
              </Button>
              <Button
                data-test="desktop-redirect-different"
                variant="flat"
                className="w-full"
                onPress={handleDifferentAccount}
              >
                {t('desktopRedirectDifferentAccount')}
              </Button>
            </div>
          )}

          {status === 'redirecting' && (
            <div className="flex flex-col items-center gap-3">
              <Spinner size="lg" color="primary" />
              <p className="text-center text-sm text-default-500">{t('desktopRedirectSuccess')}</p>
            </div>
          )}

          {status === 'done' && (
            <div className="flex flex-col items-center gap-3">
              <p className="text-center text-sm text-success">{t('desktopRedirectDone')}</p>
            </div>
          )}

          {status === 'error' && (
            <div className="flex flex-col items-center gap-3">
              <p className="text-center text-sm text-danger">{error}</p>
              <Button variant="flat" onPress={() => setStatus('confirm')}>
                {t('desktopLoginRetry')}
              </Button>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  )
}
