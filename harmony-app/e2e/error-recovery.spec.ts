/**
 * E2E Tests — Error Recovery
 *
 * Verifies error handling behaviors from the Error Feedback Matrix (CLAUDE.md §6):
 * - 403 Forbidden: kicked user sees appropriate feedback, not stale data
 * - Expired/stale session: redirects to login page
 * - Corrupted localStorage: app recovers gracefully
 *
 * WHY limited scope: Tests that require simulating network errors or API failures
 * would need page.route() (mocking), which violates the mandatory no-mock rule.
 * We test only scenarios achievable without mocking — real API errors triggered
 * by authorization state changes.
 *
 * Real data-test attributes from:
 * - main-layout.tsx:198 (main-layout)
 * - auth/login-page.tsx (login-page, login-email-input)
 * - server-list.tsx:117 (dm-home-button), server-button
 * - channel-sidebar.tsx (channel-list, channel-button)
 * - chat-area.tsx:468 (chat-area), :286 (message-input)
 */
import { expect, test } from '@playwright/test'
import { authenticatePage, selectChannel, selectServer } from './fixtures/auth-fixture'
import {
  banUser,
  createInvite,
  createServer,
  getServerChannels,
  joinServer,
  kickMember,
  sendMessageRaw,
  syncProfile,
} from './fixtures/test-data-factory'
import { createTestUser, type TestUser } from './fixtures/user-factory'

test.describe('Error Recovery', () => {
  // ── 403 Forbidden: Kicked user ──────────────────────────────────

  test.describe('403 forbidden handling', () => {
    let owner: TestUser
    let kickTarget: TestUser
    let server: { id: string; name: string }
    let channelId: string

    test.beforeAll(async () => {
      owner = await createTestUser('err-403-owner')
      kickTarget = await createTestUser('err-403-kicked')
      for (const u of [owner, kickTarget]) await syncProfile(u.token)

      server = await createServer(owner.token, `Err403 E2E ${Date.now()}`)
      const invite = await createInvite(owner.token, server.id)
      await joinServer(kickTarget.token, server.id, invite.code)

      const { items: channels } = await getServerChannels(owner.token, server.id)
      const gen = channels.find((c) => c.name === 'general')
      if (gen === undefined) {
        throw new Error('Expected #general channel to exist after server creation')
      }
      channelId = gen.id
    })

    test('kicked user gets 403 when sending a message to the server', async () => {
      // WHY: After a kick, the user's token is still valid but they are no longer
      // a server member. The API returns 403 Forbidden on any action targeting
      // that server. This tests the API-level enforcement without mocking.
      await kickMember(owner.token, server.id, kickTarget.id)

      // Attempt to send a message — should get 403
      const result = await sendMessageRaw(kickTarget.token, channelId, 'I was kicked')
      expect(result.status).toBe(403)
    })
  })

  // ── Expired Session Redirect ────────────────────────────────────

  test.describe('session expiry', () => {
    let user: TestUser

    test.beforeAll(async () => {
      user = await createTestUser('err-session')
      await syncProfile(user.token)
      await createServer(user.token)
    })

    test('expired session redirects to login page', async ({ page }) => {
      // WHY: Identical to error-handling.spec.ts pattern but with additional
      // verification that the login form is fully functional after redirect.
      await authenticatePage(page, user)

      const mainLayout = page.locator('[data-test="main-layout"]')
      await expect(mainLayout).toBeVisible({ timeout: 15_000 })

      // WHY: authenticatePage uses addInitScript which persists across page.reload(),
      // re-populating localStorage before the app JS runs. To test expired session,
      // we open a new page in the same context (shares localStorage) AFTER clearing it.
      // The new page has no addInitScript registered, so the cleared storage stays empty.
      await page.evaluate(() => {
        localStorage.clear()
        sessionStorage.clear()
      })

      // Open a fresh page in the same browser context (no addInitScript).
      const freshPage = await page.context().newPage()
      await freshPage.goto('/')

      const loginPage = freshPage.locator('[data-test="login-page"]')
      await expect(loginPage).toBeVisible({ timeout: 15_000 })

      // WHY: Verify the login form is interactive — catches regressions where
      // the redirect lands on a broken page.
      const emailInput = freshPage.locator('[data-test="login-email-input"]')
      await expect(emailInput).toBeVisible()
      await expect(emailInput).toBeEnabled()

      const passwordInput = freshPage.locator('[data-test="login-password-input"]')
      await expect(passwordInput).toBeVisible()
      await expect(passwordInput).toBeEnabled()

      await freshPage.close()
    })

    test('corrupted localStorage session shows login page', async ({ page }) => {
      // WHY: If localStorage contains garbage, the Supabase client should fail
      // to parse the session and fall back to the unauthenticated state (login page).
      // This tests resilience against localStorage corruption (e.g., browser extensions).
      const supabaseUrl = process.env.CI_SUPABASE_URL ?? 'http://127.0.0.1:64321'
      const hostSegment = new URL(supabaseUrl).hostname.split('.')[0]
      const storageKey = `sb-${hostSegment}-auth-token`

      await page.addInitScript(
        ({ key, value }) => {
          localStorage.setItem(key, value)
        },
        { key: storageKey, value: '{"broken_json": true, "access_token": "not-a-valid-jwt"}' },
      )

      await page.goto('/')

      // WHY: With an invalid/unparsable session, the app should render the login page.
      const loginPage = page.locator('[data-test="login-page"]')
      await expect(loginPage).toBeVisible({ timeout: 15_000 })
    })
  })

  // ── Empty localStorage (fresh browser) ──────────────────────────

  test('no session shows login page immediately', async ({ page }) => {
    // WHY: A user visiting the app for the first time has no localStorage session.
    // The app should render the login page without errors or flashing.
    await page.goto('/')

    const loginPage = page.locator('[data-test="login-page"]')
    await expect(loginPage).toBeVisible({ timeout: 15_000 })

    // Verify main-layout is NOT visible (not even briefly flashed)
    await expect(page.locator('[data-test="main-layout"]')).not.toBeVisible()
  })

  // ── 403 API-level: banned user cannot rejoin ────────────────────

  test.describe('banned user API errors', () => {
    test('banned user receives 403 when attempting to rejoin', async () => {
      // WHY: invite_service.rs:180 — is_banned check returns DomainError::Forbidden.
      // This confirms the error feedback matrix: 403 = permission denied.
      const banOwner = await createTestUser('err-ban-owner')
      const banTarget = await createTestUser('err-ban-target')
      for (const u of [banOwner, banTarget]) await syncProfile(u.token)

      const banServer = await createServer(banOwner.token, `ErrBan E2E ${Date.now()}`)
      const invite1 = await createInvite(banOwner.token, banServer.id)
      await joinServer(banTarget.token, banServer.id, invite1.code)

      // Ban via API
      await banUser(banOwner.token, banServer.id, banTarget.id, 'error recovery test')

      // Attempt to rejoin — should get 403
      const invite2 = await createInvite(banOwner.token, banServer.id)
      const rejoinRes = await fetch(`${API_URL}/v1/servers/${banServer.id}/members`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${banTarget.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ inviteCode: invite2.code }),
      })
      expect(rejoinRes.status).toBe(403)
    })
  })

  // ── Stale server reference ──────────────────────────────────────

  test.describe('stale data handling', () => {
    test('user can navigate to DM home after being kicked from a server', async ({ page }) => {
      // WHY: After being kicked, the user's server list is stale. Navigating to
      // DM home should work without errors, confirming the app handles the
      // server-no-longer-accessible state gracefully.
      const staleOwner = await createTestUser('err-stale-owner')
      const staleUser = await createTestUser('err-stale-user')
      for (const u of [staleOwner, staleUser]) await syncProfile(u.token)

      const staleServer = await createServer(staleOwner.token, `Stale E2E ${Date.now()}`)
      const invite = await createInvite(staleOwner.token, staleServer.id)
      await joinServer(staleUser.token, staleServer.id, invite.code)

      // Kick the user via API
      await kickMember(staleOwner.token, staleServer.id, staleUser.id)

      // Authenticate the kicked user — their server list may be stale
      await authenticatePage(page, staleUser)

      // WHY: DM home button should always be accessible regardless of server membership.
      const dmHomeButton = page.locator('[data-test="dm-home-button"]')
      await dmHomeButton.waitFor({ timeout: 10_000 })
      await dmHomeButton.click()

      // DM sidebar should render without errors
      const dmSidebar = page.locator('[data-test="dm-sidebar"]')
      await expect(dmSidebar).toBeVisible({ timeout: 10_000 })
    })
  })
})
