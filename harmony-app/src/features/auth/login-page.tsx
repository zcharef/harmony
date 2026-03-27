import { Button, Card, CardBody, CardHeader, Chip, Divider, Input, Spinner } from '@heroui/react'
import { Turnstile, type TurnstileInstance } from '@marsidev/react-turnstile'
import { CircleCheck, CircleX } from 'lucide-react'
import type { FormEvent } from 'react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { checkUsername } from '@/lib/api'
import { env } from '@/lib/env'
import { logger } from '@/lib/logger'
import { supabase } from '@/lib/supabase'

type AuthMode = 'login' | 'signup'

// WHY: Matches the DB constraint on profiles.username — lowercase alphanumeric + underscores, 3-32 chars.
const USERNAME_REGEX = /^[a-z0-9_]{3,32}$/

type UsernameStatus = 'idle' | 'checking' | 'available' | 'taken'

// WHY extracted: Keeps LoginPage below Biome's cognitive complexity limit of 15.
function UsernameStatusIcon({ status }: { status: UsernameStatus }) {
  if (status === 'checking') return <Spinner size="sm" />
  if (status === 'available') return <CircleCheck className="h-5 w-5 text-success" />
  if (status === 'taken') return <CircleX className="h-5 w-5 text-danger" />
  return null
}

function UsernameField({
  username,
  onValueChange,
  usernameStatus,
}: {
  username: string
  onValueChange: (value: string) => void
  usernameStatus: UsernameStatus
}) {
  const { t } = useTranslation('auth')

  const isFormatInvalid = username.length > 0 && !USERNAME_REGEX.test(username)

  function getErrorMessage(): string | undefined {
    if (usernameStatus === 'taken') return t('usernameTaken')
    if (isFormatInvalid) return t('usernameInvalid')
    return undefined
  }

  return (
    <Input
      data-test="login-username-input"
      label={t('username')}
      type="text"
      placeholder={t('usernamePlaceholder')}
      description={usernameStatus === 'available' ? t('usernameAvailable') : t('usernameHelp')}
      value={username}
      onValueChange={onValueChange}
      isRequired
      isInvalid={isFormatInvalid || usernameStatus === 'taken'}
      errorMessage={getErrorMessage()}
      color={
        usernameStatus === 'available'
          ? 'success'
          : usernameStatus === 'taken'
            ? 'danger'
            : 'default'
      }
      endContent={<UsernameStatusIcon status={usernameStatus} />}
      autoComplete="username"
      maxLength={32}
    />
  )
}

// WHY: Matches supabase config.toml — minimum_password_length = 8, password_requirements = "letters_digits".
const PASSWORD_HAS_LETTER = /[a-zA-Z]/
const PASSWORD_HAS_DIGIT = /\d/
const PASSWORD_MIN_LENGTH = 8

function isPasswordValid(pw: string): boolean {
  return (
    pw.length >= PASSWORD_MIN_LENGTH && PASSWORD_HAS_LETTER.test(pw) && PASSWORD_HAS_DIGIT.test(pw)
  )
}

function PasswordRequirement({ met, label }: { met: boolean; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      {met ? (
        <CircleCheck className="h-3.5 w-3.5 text-success" />
      ) : (
        <CircleX className="h-3.5 w-3.5 text-default-400" />
      )}
      <span className={met ? 'text-xs text-success' : 'text-xs text-default-400'}>{label}</span>
    </div>
  )
}

// WHY extracted: Keeps LoginPage below Biome's cognitive complexity limit of 15.
function PasswordField({
  password,
  onValueChange,
  isSignup,
}: {
  password: string
  onValueChange: (value: string) => void
  isSignup: boolean
}) {
  const { t } = useTranslation('auth')
  const showHints = isSignup && password.length > 0

  return (
    <div className="flex flex-col gap-1.5">
      <Input
        data-test="login-password-input"
        label={t('password')}
        type="password"
        placeholder={t('passwordPlaceholder')}
        value={password}
        onValueChange={onValueChange}
        isRequired
        autoComplete={isSignup ? 'new-password' : 'current-password'}
      />
      {showHints && (
        <div className="flex flex-col gap-0.5 px-1">
          <PasswordRequirement
            met={password.length >= PASSWORD_MIN_LENGTH}
            label={t('passwordMinLength')}
          />
          <PasswordRequirement
            met={PASSWORD_HAS_LETTER.test(password)}
            label={t('passwordNeedsLetter')}
          />
          <PasswordRequirement
            met={PASSWORD_HAS_DIGIT.test(password)}
            label={t('passwordNeedsDigit')}
          />
        </div>
      )}
    </div>
  )
}

export function LoginPage() {
  const { t } = useTranslation('auth')
  const [mode, setMode] = useState<AuthMode>('login')
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [honeypot, setHoneypot] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [captchaToken, setCaptchaToken] = useState<string | null>(null)
  const [usernameStatus, setUsernameStatus] = useState<UsernameStatus>('idle')
  const turnstileRef = useRef<TurnstileInstance>(null)

  // WHY: Debounced availability check — only fires when the username passes
  // local validation (regex), after a 400ms pause in typing. Avoids hammering
  // the API on every keystroke.
  useEffect(() => {
    if (mode !== 'signup' || !USERNAME_REGEX.test(username)) {
      setUsernameStatus('idle')
      return
    }

    setUsernameStatus('checking')
    const timer = setTimeout(async () => {
      try {
        const { data } = await checkUsername({
          query: { username },
          throwOnError: true,
        })
        setUsernameStatus(data.available ? 'available' : 'taken')
      } catch (err: unknown) {
        // WHY: Network/server errors should not block the user from submitting.
        // The server will reject duplicates at signup time anyway.
        logger.error('username_check_failed', {
          error: err instanceof Error ? err.message : 'Unknown error',
        })
        setUsernameStatus('idle')
      }
    }, 400)

    return () => clearTimeout(timer)
  }, [username, mode])

  const isUsernameValid = USERNAME_REGEX.test(username)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()

    // WHY: Bots auto-fill hidden fields. Real users never see this field.
    // Silent rejection — no error message to avoid revealing the trap.
    if (honeypot.length > 0) {
      return
    }

    if (mode === 'signup' && !isUsernameValid) {
      setError(t('usernameInvalid'))
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
            options: {
              captchaToken,
              data: { username },
            },
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
    setUsername('')
    setPassword('')
    setUsernameStatus('idle')
    setError(null)
    setSuccessMessage(null)
  }

  return (
    <div
      data-test="login-page"
      className="flex min-h-screen items-center justify-center bg-background p-4"
    >
      <Card className="w-full max-w-md">
        <CardHeader className="flex flex-col items-center gap-2 pb-0 pt-6">
          <img
            src="/brand/logo_vertical_dark.png"
            alt="Harmony"
            data-test="login-heading"
            className="h-24 w-auto"
          />
          <Chip color="secondary" size="sm" variant="dot">
            {t('alphaLabel', { ns: 'common' })}
          </Chip>
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
                {mode === 'signup' && (
                  <UsernameField
                    username={username}
                    onValueChange={(v) => setUsername(v.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
                    usernameStatus={usernameStatus}
                  />
                )}

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

                <PasswordField
                  password={password}
                  onValueChange={setPassword}
                  isSignup={mode === 'signup'}
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
                  isDisabled={
                    captchaToken === null ||
                    (mode === 'signup' &&
                      (!isUsernameValid ||
                        usernameStatus === 'taken' ||
                        !isPasswordValid(password)))
                  }
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
