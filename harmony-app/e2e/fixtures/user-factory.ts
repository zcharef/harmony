/**
 * Creates test users via the Supabase Admin API (service_role key).
 *
 * WHY: E2E tests need isolated users that don't collide across parallel runs.
 * The Admin API bypasses email confirmation, so users can log in immediately.
 */

// WHY: Configurable for CI (Supabase Cloud) while defaulting to local dev.
// Local-dev keys are standard supabase local defaults. Not secrets.
const SUPABASE_URL = process.env.CI_SUPABASE_URL ?? 'http://127.0.0.1:64321'
const SERVICE_ROLE_KEY =
  process.env.CI_SUPABASE_SERVICE_ROLE_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'
const ANON_KEY =
  process.env.CI_SUPABASE_ANON_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'

export interface TestUser {
  id: string
  email: string
  password: string
  token: string
  refreshToken: string
}

/**
 * Creates a user via Supabase Admin API and returns credentials + access token.
 * The prefix is used to namespace users per test suite to avoid collisions.
 */
export async function createTestUser(prefix: string): Promise<TestUser> {
  const uniqueId = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const email = `${uniqueId}@e2e.test`
  const password = 'TestPassword123!'

  // WHY: Admin API auto-confirms the user (email_confirm: true),
  // so no email verification is needed for E2E tests.
  const createRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      apikey: SERVICE_ROLE_KEY,
    },
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: { display_name: prefix, username: uniqueId },
    }),
  })

  if (!createRes.ok) {
    const body = await createRes.text()
    throw new Error(`Failed to create test user: ${createRes.status} ${body}`)
  }

  const user = (await createRes.json()) as { id: string }

  // WHY: Sign in to get an access_token for API calls.
  const signInRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: ANON_KEY,
    },
    body: JSON.stringify({
      email,
      password,
      gotrue_meta_security: { captcha_token: 'test-token' },
    }),
  })

  if (!signInRes.ok) {
    const body = await signInRes.text()
    throw new Error(`Failed to sign in test user: ${signInRes.status} ${body}`)
  }

  const session = (await signInRes.json()) as { access_token: string; refresh_token: string }

  return {
    id: user.id,
    email,
    password,
    token: session.access_token,
    refreshToken: session.refresh_token,
  }
}
