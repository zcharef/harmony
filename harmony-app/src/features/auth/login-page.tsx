import { Button, Card, CardBody, CardHeader, Chip, Divider, Input } from '@heroui/react'
import { Turnstile, type TurnstileInstance } from '@marsidev/react-turnstile'
import type { FormEvent } from 'react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { env } from '@/lib/env'
import { supabase } from '@/lib/supabase'

type AuthMode = 'login' | 'signup'

export function LoginPage() {
  const { t } = useTranslation('auth')
  const [mode, setMode] = useState<AuthMode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [honeypot, setHoneypot] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [captchaToken, setCaptchaToken] = useState<string | null>(null)
  const turnstileRef = useRef<TurnstileInstance>(null)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()

    // WHY: Bots auto-fill hidden fields. Real users never see this field.
    // Silent rejection — no error message to avoid revealing the trap.
    if (honeypot.length > 0) {
      return
    }

    if (captchaToken === null) {
      setError(t('captchaRequired'))
      return
    }

    setError(null)
    setSuccessMessage(null)
    setIsSubmitting(true)

    const result =
      mode === 'login'
        ? await supabase.auth.signInWithPassword({
            email,
            password,
            options: { captchaToken },
          })
        : await supabase.auth.signUp({
            email,
            password,
            options: { captchaToken },
          })

    if (result.error) {
      setError(result.error.message)
      // WHY: Turnstile tokens are single-use. After a failed attempt,
      // we must reset the widget to get a fresh token for the retry.
      turnstileRef.current?.reset()
      setCaptchaToken(null)
    } else if (mode === 'signup' && result.data.session === null) {
      // WHY: When email confirmation is enabled, signUp returns session=null.
      // The user exists but must verify their email before they can log in.
      setSuccessMessage(t('checkYourEmail'))
    }

    setIsSubmitting(false)
  }

  function toggleMode() {
    setMode((prev) => (prev === 'login' ? 'signup' : 'login'))
    setError(null)
    setSuccessMessage(null)
  }

  return (
    <div
      data-test="login-page"
      className="flex min-h-screen items-center justify-center bg-background p-4"
    >
      <Card className="w-full max-w-md">
        <CardHeader className="flex flex-col items-center gap-1 pb-0 pt-6">
          <div className="flex items-center gap-2">
            <h1 data-test="login-heading" className="text-2xl font-bold text-foreground">
              {t('appName')}
            </h1>
            <Chip color="warning" size="sm" variant="flat">
              {t('alphaLabel', { ns: 'common' })}
            </Chip>
          </div>
          <p data-test="login-subtitle" className="text-sm text-default-500">
            {mode === 'login' ? t('welcomeBack') : t('createYourAccount')}
          </p>
        </CardHeader>

        <CardBody className="gap-4 px-6 pb-6">
          {successMessage !== null ? (
            <div data-test="login-success-message" className="flex flex-col items-center gap-4">
              <p className="text-center text-sm text-success">{successMessage}</p>
              <Button
                data-test="login-back-to-signin"
                variant="flat"
                onPress={() => {
                  setMode('login')
                  setSuccessMessage(null)
                }}
              >
                {t('switchToSignIn')}
              </Button>
            </div>
          ) : (
            <>
              <form data-test="login-form" onSubmit={handleSubmit} className="flex flex-col gap-4">
                <Input
                  data-test="login-email-input"
                  label={t('email')}
                  type="email"
                  placeholder={t('emailPlaceholder')}
                  value={email}
                  onValueChange={setEmail}
                  isRequired
                  autoComplete="email"
                />

                <Input
                  data-test="login-password-input"
                  label={t('password')}
                  type="password"
                  placeholder={t('passwordPlaceholder')}
                  value={password}
                  onValueChange={setPassword}
                  isRequired
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                />

                {/* WHY: Honeypot field — invisible to real users, auto-filled by bots.
                    Positioned off-screen, excluded from tab order and screen readers. */}
                <input
                  data-test="login-honeypot"
                  name="website"
                  type="text"
                  value={honeypot}
                  onChange={(e) => setHoneypot(e.target.value)}
                  tabIndex={-1}
                  aria-hidden="true"
                  autoComplete="off"
                  className="absolute -left-[9999px] h-0 w-0 opacity-0"
                />

                <div data-test="login-captcha-wrapper">
                  <Turnstile
                    ref={turnstileRef}
                    siteKey={env.VITE_TURNSTILE_SITE_KEY}
                    onSuccess={setCaptchaToken}
                    onExpire={() => setCaptchaToken(null)}
                    onError={() => {
                      setCaptchaToken(null)
                      setError(t('captchaError'))
                    }}
                    options={{ theme: 'auto', size: 'flexible' }}
                  />
                </div>

                {error !== null && (
                  <p data-test="login-error-message" className="text-sm text-danger">
                    {error}
                  </p>
                )}

                <Button
                  data-test="login-submit-button"
                  type="submit"
                  color="primary"
                  isLoading={isSubmitting}
                  isDisabled={captchaToken === null}
                  className="mt-2"
                >
                  {mode === 'login' ? t('signIn') : t('signUp')}
                </Button>
              </form>

              <Divider />

              <p className="text-center text-sm text-default-500">
                {mode === 'login' ? t('noAccount') : t('hasAccount')}{' '}
                <button
                  data-test="login-toggle-button"
                  type="button"
                  onClick={toggleMode}
                  className="font-medium text-primary hover:underline"
                >
                  {mode === 'login' ? t('switchToSignUp') : t('switchToSignIn')}
                </button>
              </p>
            </>
          )}
        </CardBody>
      </Card>
    </div>
  )
}
