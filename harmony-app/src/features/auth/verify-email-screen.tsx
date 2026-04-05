import { Button, Card, CardBody, CardHeader, Chip } from '@heroui/react'
import { MailCheck } from 'lucide-react'
import { useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { logger } from '@/lib/logger'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from './stores/auth-store'

type ResendStatus = 'idle' | 'sending' | 'sent' | 'error'

/**
 * WHY: Defense-in-depth gate for unverified emails. In production, Supabase
 * won't issue a session for unconfirmed users, so this screen rarely appears.
 * It catches edge cases: local dev with `enable_confirmations = false` (now
 * fixed), or a hypothetical Supabase misconfiguration. The backend API already
 * returns 403 for unverified users — this screen prevents the broken UX of
 * being "in" the app with every call failing.
 */
export function VerifyEmailScreen({ email }: { email: string }) {
  const { t } = useTranslation('auth')
  const [resendStatus, setResendStatus] = useState<ResendStatus>('idle')

  async function handleResend() {
    setResendStatus('sending')
    try {
      const { error } = await supabase.auth.resend({ type: 'signup', email })
      if (error) {
        logger.error('resend_confirmation_failed', { error: error.message })
        setResendStatus('error')
        return
      }
      setResendStatus('sent')
    } catch (err: unknown) {
      logger.error('resend_confirmation_failed', {
        error: err instanceof Error ? err.message : 'Unknown error',
      })
      setResendStatus('error')
    }
  }

  async function handleLogout() {
    await supabase.auth.signOut()
    useAuthStore.getState().clear()
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

        <CardBody className="flex flex-col items-center gap-5 px-6 pb-6">
          <MailCheck className="h-12 w-12 text-primary" />
          <h2 className="text-lg font-semibold">{t('verifyEmailTitle')}</h2>
          <p className="text-center text-sm text-default-500">
            <Trans i18nKey="verifyEmailDescription" ns="auth" values={{ email }}>
              We sent a confirmation link to{' '}
              <span className="font-medium text-foreground">{email}</span>. Please check your inbox
              and click the link to activate your account.
            </Trans>
          </p>

          {resendStatus === 'sent' && (
            <p className="text-sm text-success">{t('resendEmailSuccess')}</p>
          )}
          {resendStatus === 'error' && (
            <p className="text-sm text-danger">{t('resendEmailError')}</p>
          )}

          <div className="flex w-full flex-col gap-2">
            <Button
              color="primary"
              variant="flat"
              onPress={handleResend}
              isLoading={resendStatus === 'sending'}
              isDisabled={resendStatus === 'sent'}
            >
              {t('resendEmail')}
            </Button>
            <Button variant="light" onPress={handleLogout}>
              {t('logout')}
            </Button>
          </div>
        </CardBody>
      </Card>
    </div>
  )
}
