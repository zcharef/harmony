import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
// WHY: Side-effect import initializes the real i18n instance so labels/aria
// resolve to actual translations (the display-name copy lives in auth.json).
import '@/lib/i18n'
import { LoginPage } from './login-page'

// WHY: The repo uses data-test (not data-testid) — align Testing Library queries.
configure({ testIdAttribute: 'data-test' })

// WHY: Typed to the single arg LoginPage passes, so `mock.calls[0][0]` is typed
// and the metadata assertion needs no `as` cast (ADR-035).
type SignUpCall = { options: { data: Record<string, string> } }

// WHY: vi.mock factories are hoisted above module-scope consts, so the mock fn
// must be created via vi.hoisted to be referenceable inside the factory.
const { signUpMock } = vi.hoisted(() => ({
  signUpMock: vi.fn(async (_args: SignUpCall) => ({
    // Non-null user with identities → NOT treated as a duplicate-email signup.
    data: { user: { identities: [{ id: 'identity-1' }] }, session: null },
    error: null,
  })),
}))

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      signUp: signUpMock,
      signInWithPassword: vi.fn(),
      signInWithOtp: vi.fn(() => ({ catch: vi.fn() })),
      resetPasswordForEmail: vi.fn(),
    },
  },
}))

// WHY: The debounced availability check calls this — stub it so no real fetch fires.
vi.mock('@/lib/api', () => ({
  checkUsername: vi.fn(async () => ({ data: { available: true }, error: undefined })),
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// WHY: Force the self-hosted-bypass captcha path (VITE_TURNSTILE_SITE_KEY
// undefined) so the form is submittable without a Turnstile token. Otherwise
// captchaToken starts null and handleSubmit early-returns before signUp,
// making this test depend on whether the ambient test env sets the key.
vi.mock('@/lib/env', () => ({
  env: {
    VITE_API_URL: 'http://localhost:3000',
    VITE_SUPABASE_URL: 'http://localhost:54321',
    VITE_SUPABASE_ANON_KEY: 'test-anon-key',
    VITE_TURNSTILE_SITE_KEY: undefined,
  },
}))

function switchToSignup() {
  fireEvent.click(screen.getByTestId('login-toggle-button'))
}

function fillField(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

describe('LoginPage — signup display name', () => {
  beforeEach(() => {
    signUpMock.mockClear()
  })

  it('hides the display-name field in login mode, shows it in signup mode', () => {
    render(<LoginPage />)
    expect(screen.queryByTestId('login-display-name-input')).toBeNull()

    switchToSignup()
    expect(screen.getByTestId('login-display-name-input')).not.toBeNull()
  })

  it('passes a typed display_name into the signUp metadata', async () => {
    render(<LoginPage />)
    switchToSignup()

    fillField('Username', 'cooluser')
    fillField('Display name', 'Cool Name')
    fillField('Email', 'cool@example.com')
    fillField('Password', 'password1')

    fireEvent.click(screen.getByTestId('login-submit-button'))

    await waitFor(() => expect(signUpMock).toHaveBeenCalledTimes(1))
    const call = signUpMock.mock.calls[0]?.[0]
    expect(call?.options.data).toEqual({ username: 'cooluser', display_name: 'Cool Name' })
  })

  it('omits display_name entirely when the field is left blank', async () => {
    render(<LoginPage />)
    switchToSignup()

    fillField('Username', 'cooluser')
    fillField('Email', 'cool@example.com')
    fillField('Password', 'password1')
    // WHY: whitespace-only must be treated as blank → key omitted (not "").
    fillField('Display name', '   ')

    fireEvent.click(screen.getByTestId('login-submit-button'))

    await waitFor(() => expect(signUpMock).toHaveBeenCalledTimes(1))
    const call = signUpMock.mock.calls[0]?.[0]
    expect(call?.options.data).toEqual({ username: 'cooluser' })
    expect(call?.options.data).not.toHaveProperty('display_name')
  })
})
