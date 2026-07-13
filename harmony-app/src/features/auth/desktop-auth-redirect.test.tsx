import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/lib/i18n'
import { DesktopAuthRedirect } from './desktop-auth-redirect'

// WHY: The repo uses data-test (not data-testid) — align Testing Library queries.
configure({ testIdAttribute: 'data-test' })

// WHY vi.hoisted: referenced inside the hoisted vi.mock factories below.
type CreateCall = { body: Record<string, unknown>; throwOnError?: boolean }

const { createDesktopAuthCodeMock, getSessionMock } = vi.hoisted(() => ({
  createDesktopAuthCodeMock: vi.fn(async (_opts: { body: Record<string, unknown> }) => ({
    data: { authCode: 'auth-code-123' },
  })),
  getSessionMock: vi.fn(async () => ({
    data: { session: { refresh_token: 'web-refresh-token', access_token: 'web-access' } },
  })),
}))

vi.mock('@/lib/api', () => ({
  createDesktopAuthCode: createDesktopAuthCodeMock,
}))

vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: getSessionMock, signOut: vi.fn() } },
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

vi.mock('./stores/auth-store', () => ({
  useAuthStore: () => ({ user: { email: 'me@example.com' } }),
}))

describe('DesktopAuthRedirect', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // WHY: The component reads code_challenge + state from the URL and assigns
    // window.location.href on success. Replace location with a plain object so
    // jsdom does not throw on the harmony:// navigation.
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { search: '?code_challenge=test-challenge&state=test-state', href: '' },
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('creates the auth code WITHOUT forwarding the web refresh token', async () => {
    render(<DesktopAuthRedirect />)

    fireEvent.click(screen.getByTestId('desktop-redirect-continue'))

    await waitFor(() => {
      expect(createDesktopAuthCodeMock).toHaveBeenCalledOnce()
    })

    const call: CreateCall | undefined = createDesktopAuthCodeMock.mock.calls[0]?.[0]
    // The body carries only the PKCE challenge — the refresh token is NEVER sent.
    expect(call?.body).toEqual({ codeChallenge: 'test-challenge' })
    expect(call?.body).not.toHaveProperty('refreshToken')
  })
})
