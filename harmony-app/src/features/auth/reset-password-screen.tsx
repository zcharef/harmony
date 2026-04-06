import { Button, Card, CardBody, CardHeader, Chip, Input } from '@heroui/react'
import { KeyRound } from 'lucide-react'
import type { FormEvent } from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { logger } from '@/lib/logger'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from './stores/auth-store'

// WHY: Matches supabase config.toml — minimum_password_length = 8, password_requirements = "letters_digits".
const PASSWORD_HAS_LETTER = /[a-zA-Z]/
const PASSWORD_HAS_DIGIT = /\d/
const PASSWORD_MIN_LENGTH = 8

function isPasswordValid(pw: string): boolean {
  return (
    pw.length >= PASSWORD_MIN_LENGTH && PASSWORD_HAS_LETTER.test(pw) && PASSWORD_HAS_DIGIT.test(pw)
  )
}

type ResetStatus = 'idle' | 'submitting' | 'success'

/**
 * WHY: Shown after the user clicks a password reset link from their email.
 * Supabase processes the recovery token from the URL, establishes a session,
 * and fires PASSWORD_RECOVERY via onAuthStateChange. The auth store flag
 * isPasswordRecovery gates this screen in App.tsx.
 */
export function ResetPasswordScreen() {
  const { t } = useTranslation('auth')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<ResetStatus>('idle')

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)

    if (!isPasswordValid(password)) {
      return
    }

    if (password !== confirmPassword) {
      setError(t('passwordsDoNotMatch'))
      return
    }

    setStatus('submitting')

    try {
      const { error: updateError } = await supabase.auth.updateUser({ password })
      if (updateError) {
        logger.error('password_reset_failed', { error: updateError.message })
        setError(t('resetPasswordError'))
        setStatus('idle')
        return
      }

      setStatus('success')
      // WHY: Brief delay so the user sees the success message before the app loads.
      setTimeout(() => {
        useAuthStore.getState().setPasswordRecovery(false)
      }, 1500)
    } catch (err: unknown) {
      logger.error('password_reset_failed', {
        error: err instanceof Error ? err.message : 'Unknown error',
      })
      setError(t('resetPasswordError'))
      setStatus('idle')
    }
  }

  const showPasswordHints = password.length > 0

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
          <KeyRound className="h-12 w-12 text-primary" />
          <h2 className="text-lg font-semibold">{t('resetPasswordTitle')}</h2>

          {status === 'success' ? (
            <p className="text-center text-sm text-success">{t('resetPasswordSuccess')}</p>
          ) : (
            <form onSubmit={handleSubmit} className="flex w-full flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Input
                  label={t('newPassword')}
                  type="password"
                  value={password}
                  onValueChange={setPassword}
                  autoComplete="new-password"
                  isRequired
                />
                {showPasswordHints && (
                  <div className="flex flex-col gap-0.5 px-1">
                    <PasswordHint
                      met={password.length >= PASSWORD_MIN_LENGTH}
                      label={t('passwordMinLength')}
                    />
                    <PasswordHint
                      met={PASSWORD_HAS_LETTER.test(password)}
                      label={t('passwordNeedsLetter')}
                    />
                    <PasswordHint
                      met={PASSWORD_HAS_DIGIT.test(password)}
                      label={t('passwordNeedsDigit')}
                    />
                  </div>
                )}
              </div>

              <Input
                label={t('confirmPassword')}
                type="password"
                value={confirmPassword}
                onValueChange={setConfirmPassword}
                placeholder={t('confirmPasswordPlaceholder')}
                autoComplete="new-password"
                isRequired
                isInvalid={confirmPassword.length > 0 && password !== confirmPassword}
                errorMessage={
                  confirmPassword.length > 0 && password !== confirmPassword
                    ? t('passwordsDoNotMatch')
                    : undefined
                }
              />

              {error !== null && <p className="text-sm text-danger">{error}</p>}

              <Button
                type="submit"
                color="primary"
                isLoading={status === 'submitting'}
                isDisabled={!isPasswordValid(password) || confirmPassword.length === 0}
              >
                {t('updatePassword')}
              </Button>
            </form>
          )}
        </CardBody>
      </Card>
    </div>
  )
}

function PasswordHint({ met, label }: { met: boolean; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={met ? 'text-xs text-success' : 'text-xs text-default-400'}>{label}</span>
    </div>
  )
}
