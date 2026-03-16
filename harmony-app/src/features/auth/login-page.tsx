import { Button, Card, CardBody, CardHeader, Divider, Input } from '@heroui/react'
import type { FormEvent } from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase'

type AuthMode = 'login' | 'signup'

export function LoginPage() {
  const { t } = useTranslation('auth')
  const [mode, setMode] = useState<AuthMode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setIsSubmitting(true)

    const result =
      mode === 'login'
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password })

    if (result.error) {
      setError(result.error.message)
    }

    setIsSubmitting(false)
  }

  function toggleMode() {
    setMode((prev) => (prev === 'login' ? 'signup' : 'login'))
    setError(null)
  }

  return (
    <div
      data-test="login-page"
      className="flex min-h-screen items-center justify-center bg-background p-4"
    >
      <Card className="w-full max-w-md">
        <CardHeader className="flex flex-col items-center gap-1 pb-0 pt-6">
          <h1 data-test="login-heading" className="text-2xl font-bold text-foreground">
            {t('appName')}
          </h1>
          <p data-test="login-subtitle" className="text-sm text-default-500">
            {mode === 'login' ? t('welcomeBack') : t('createYourAccount')}
          </p>
        </CardHeader>

        <CardBody className="gap-4 px-6 pb-6">
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
        </CardBody>
      </Card>
    </div>
  )
}
