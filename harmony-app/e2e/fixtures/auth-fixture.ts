/**
 * Auth helpers for Playwright E2E tests.
 *
 * WHY: Most tests need an authenticated session. Rather than going through
 * the login UI every time (slow, flaky), we inject the Supabase session
 * directly into localStorage. Only auth.spec.ts tests the actual login form.
 */

import type { Page } from '@playwright/test'
import type { TestUser } from './user-factory'

/**
 * Injects a Supabase session into localStorage so the page loads as authenticated.
 *
 * WHY addInitScript: The Supabase client calls `_recoverSession()` synchronously
 * during app mount, reading localStorage before any user code runs. If we navigate
 * first and then set localStorage via `page.evaluate`, the client has already read
 * an empty storage and rendered the login page (race condition).
 *
 * `addInitScript` registers a script that Playwright injects BEFORE any page JS
 * executes, guaranteeing the session token is present when Supabase initializes.
 */
export async function authenticatePage(
  page: Page,
  user: Pick<TestUser, 'token' | 'email' | 'id' | 'refreshToken'>,
): Promise<void> {
  // WHY: Supabase client key follows pattern sb-<hostname-first-segment>-auth-token.
  // For local dev (127.0.0.1), this is "sb-127-auth-token".
  // For Cloud (abcdef.supabase.co), this is "sb-abcdef-auth-token".
  const supabaseUrl = process.env.CI_SUPABASE_URL ?? 'http://127.0.0.1:64321'
  const hostSegment = new URL(supabaseUrl).hostname.split('.')[0]
  const storageKey = `sb-${hostSegment}-auth-token`

  const sessionPayload = JSON.stringify({
    access_token: user.token,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: user.refreshToken,
    user: {
      id: user.id,
      aud: 'authenticated',
      role: 'authenticated',
      email: user.email,
      email_confirmed_at: new Date().toISOString(),
      app_metadata: { provider: 'email', providers: ['email'] },
      user_metadata: { display_name: user.email.split('@')[0] },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  })

  // WHY: Register init script BEFORE navigation so localStorage is populated
  // before any page JS (including Supabase client init) executes.
  await page.addInitScript(
    ({ key, value }) => {
      localStorage.setItem(key, value)
    },
    { key: storageKey, value: sessionPayload },
  )

  await page.goto('/')

  // WHY: Confirm the authenticated UI rendered — catches regressions in the
  // auth flow without requiring every caller to duplicate this assertion.
  await page.locator('[data-test="main-layout"]').waitFor({ timeout: 15_000 })
}

/**
 * Logs in via the actual UI form. Used by auth.spec.ts only.
 * Waits for Turnstile to resolve and submits the form.
 */
export async function loginViaUI(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/')

  const emailInput = page.locator('[data-test="login-email-input"]')
  await emailInput.fill(email)

  const passwordInput = page.locator('[data-test="login-password-input"]')
  await passwordInput.fill(password)

  // WHY: Turnstile uses test key (1x00000000000000000000AA) which auto-passes,
  // but we still need to wait for it to resolve before the button is enabled.
  const submitButton = page.locator('[data-test="login-submit-button"]')
  await submitButton.waitFor({ state: 'attached', timeout: 10000 })
  // WHY: Button is disabled until captchaToken !== null. Wait for enabled state.
  await page.waitForFunction(
    (selector) => {
      const btn = document.querySelector(selector)
      return btn !== null && !(btn as HTMLButtonElement).disabled
    },
    '[data-test="login-submit-button"]',
    { timeout: 15000 },
  )

  await submitButton.click()
}

/**
 * Clicks a server in the sidebar by name.
 * WHY: Tests should navigate via UI, not by constructing URLs.
 */
export async function selectServer(page: Page, serverId: string): Promise<void> {
  // WHY: server-list renders only after useServers() query resolves (isPending === false).
  // While isPending, a Spinner is shown without the data-test="server-list" attribute.
  // Waiting for it first avoids racing against the TanStack Query cold-cache load.
  await page.locator('[data-test="server-list"]').waitFor({ timeout: 15_000 })

  // WHY: Server buttons have data-server-id attributes — direct ID match is
  // instant and deterministic. Tooltip-hover was unreliable in parallel runs.
  const btn = page.locator(`[data-test="server-button"][data-server-id="${serverId}"]`)
  await btn.waitFor({ timeout: 10_000 })
  await btn.click()

  // WHY: channel-sidebar is always in the DOM even when serverId is null.
  // Waiting for it is effectively a no-op and returns before channels load.
  // Instead, wait for a channel-button inside channel-list which confirms:
  // (a) server selection state propagated, (b) useChannels() resolved,
  // (c) at least one channel rendered.
  await page
    .locator('[data-test="channel-list"] [data-test="channel-button"]')
    .first()
    .waitFor({ timeout: 15_000 })
}

/**
 * Clicks a channel in the sidebar by name.
 */
export async function selectChannel(page: Page, channelName: string): Promise<void> {
  const channelButton = page
    .locator('[data-test="channel-button"]')
    .filter({ hasText: channelName })
  // WHY: Channel list loads asynchronously via useChannels(). Wait for the
  // target channel button to appear before clicking to avoid race conditions.
  await channelButton.waitFor({ timeout: 10_000 })
  await channelButton.click()
  await page.locator('[data-test="chat-area"]').waitFor({ timeout: 10_000 })
}
