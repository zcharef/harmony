import { expect, test } from '@playwright/test'
import { authenticatePage, selectServer } from './fixtures/auth-fixture'
import {
  createInvite,
  createServer,
  getServerChannels,
  joinServer,
  syncProfile,
} from './fixtures/test-data-factory'
import { createTestUser, type TestUser } from './fixtures/user-factory'

/**
 * Input validation E2E tests.
 *
 * Validation rules tested (from domain services):
 * - Server name: 1-100 chars after trim, no control chars (< U+0020)
 * - Channel name: ^[a-z0-9-]{1,100}$
 * - Channel topic: 0-1024 chars
 * - Ban reason: 0-512 chars
 * - Invite code: 1-32 chars, alphanumeric only
 */

test.describe('Input Validation', () => {
  let owner: TestUser
  let server: { id: string; name: string }

  test.beforeAll(async () => {
    owner = await createTestUser('val-owner')
    await syncProfile(owner.token)
    server = await createServer(owner.token)
  })

  // ── Server Name Validation ──────────────────────────────────────

  test.describe('Server Name', () => {
    test('rejects empty server name', async ({ page }) => {
      await authenticatePage(page, owner)

      // WHY: ServerList shows a Spinner (no add-server-button) while useServers()
      // is pending. Wait for the button to appear before clicking.
      const addServerBtn = page.locator('[data-test="add-server-button"]')
      await addServerBtn.waitFor({ timeout: 10_000 })
      await addServerBtn.click()
      await page.locator('[data-test="create-server-dialog"]').waitFor({ timeout: 10000 })

      // Leave name empty, submit
      const nameInput = page.locator('[data-test="server-name-input"]')
      await nameInput.fill('')
      await expect(nameInput).toHaveValue('')
      await page.locator('[data-test="create-server-submit-button"]').click()

      // WHY: Client-side Zod schema requires min(1). The zodResolver catches the
      // error before handleSubmit fires, so dialog stays open with the submit
      // button still present — no API call is made.
      await expect(page.locator('[data-test="create-server-dialog"]')).toBeVisible({
        timeout: 5000,
      })
      await expect(page.locator('[data-test="create-server-submit-button"]')).toBeVisible()
    })

    test('rejects server name exceeding 100 characters', async ({ page }) => {
      await authenticatePage(page, owner)

      // WHY: ServerList shows a Spinner (no add-server-button) while useServers()
      // is pending. Wait for the button to appear before clicking.
      const addServerBtn = page.locator('[data-test="add-server-button"]')
      await addServerBtn.waitFor({ timeout: 10_000 })
      await addServerBtn.click()
      await page.locator('[data-test="create-server-dialog"]').waitFor({ timeout: 10000 })

      const longName = 'a'.repeat(101)
      const nameInput = page.locator('[data-test="server-name-input"]')
      await nameInput.fill(longName)
      await expect(nameInput).toHaveValue(longName)

      await page.locator('[data-test="create-server-submit-button"]').click()

      // WHY: Client-side Zod schema has max(100). The zodResolver catches the
      // error before handleSubmit fires, so no POST request is ever made.
      // Dialog stays open with the submit button still present — no API call needed.
      await expect(page.locator('[data-test="create-server-dialog"]')).toBeVisible({
        timeout: 5000,
      })
      await expect(page.locator('[data-test="create-server-submit-button"]')).toBeVisible()
    })

    test('rejects server name with control characters via API', async ({ page }) => {
      await authenticatePage(page, owner)

      // WHY: ServerList shows a Spinner (no add-server-button) while useServers()
      // is pending. Wait for the button to appear before clicking.
      const addServerBtn = page.locator('[data-test="add-server-button"]')
      await addServerBtn.waitFor({ timeout: 10_000 })
      await addServerBtn.click()
      await page.locator('[data-test="create-server-dialog"]').waitFor({ timeout: 10000 })

      // Control char U+0009 (tab) — client form accepts it (no regex), but API rejects it
      const nameWithControlChar = 'Server\tName'
      const nameInput = page.locator('[data-test="server-name-input"]')
      await nameInput.fill(nameWithControlChar)

      const responsePromise = page.waitForResponse(
        (response) =>
          response.url().includes('/v1/servers') && response.request().method() === 'POST',
        { timeout: 15_000 },
      )

      await page.locator('[data-test="create-server-submit-button"]').click()

      const response = await responsePromise
      expect(response.status()).toBeGreaterThanOrEqual(400)

      await expect(page.locator('[data-test="create-server-dialog"]')).toBeVisible({
        timeout: 5000,
      })
    })
  })

  // ── Channel Name Validation ─────────────────────────────────────

  test.describe('Channel Name', () => {
    test('rejects non-lowercase channel name', async ({ page }) => {
      await authenticatePage(page, owner)
      await selectServer(page, server.id)

      // Open create channel dialog via server menu
      await page.locator('[data-test="server-header-button"]').click()
      const menuItem1 = page.locator('[data-test="server-menu-create-channel-item"]')
      await menuItem1.waitFor({ timeout: 10000 })
      await menuItem1.click()
      await page.locator('[data-test="create-channel-dialog"]').waitFor({ timeout: 10000 })

      const nameInput = page.locator('[data-test="channel-name-input"]')
      await nameInput.fill('MyChannel')
      await expect(nameInput).toHaveValue('MyChannel')
      await page.locator('[data-test="create-channel-submit-button"]').click()

      // WHY: Client-side Zod regex ^[a-z0-9-]+$ rejects uppercase. The zodResolver
      // catches the error before handleSubmit fires, so dialog stays open with the
      // submit button still present — no API call is made.
      await expect(page.locator('[data-test="create-channel-dialog"]')).toBeVisible({
        timeout: 5000,
      })
      await expect(page.locator('[data-test="create-channel-submit-button"]')).toBeVisible()
    })

    test('rejects channel name with special characters', async ({ page }) => {
      await authenticatePage(page, owner)
      await selectServer(page, server.id)

      await page.locator('[data-test="server-header-button"]').click()
      const menuItem2 = page.locator('[data-test="server-menu-create-channel-item"]')
      await menuItem2.waitFor({ timeout: 10000 })
      await menuItem2.click()
      await page.locator('[data-test="create-channel-dialog"]').waitFor({ timeout: 10000 })

      const nameInput = page.locator('[data-test="channel-name-input"]')
      await nameInput.fill('hello_world!')
      await expect(nameInput).toHaveValue('hello_world!')
      await page.locator('[data-test="create-channel-submit-button"]').click()

      // WHY: Client-side Zod regex ^[a-z0-9-]+$ rejects underscore and exclamation.
      // Dialog stays open with submit button still present — validation prevented submission.
      await expect(page.locator('[data-test="create-channel-dialog"]')).toBeVisible({
        timeout: 5000,
      })
      await expect(page.locator('[data-test="create-channel-submit-button"]')).toBeVisible()
    })

    test('rejects channel name exceeding 100 characters', async ({ page }) => {
      await authenticatePage(page, owner)
      await selectServer(page, server.id)

      await page.locator('[data-test="server-header-button"]').click()
      const menuItem3 = page.locator('[data-test="server-menu-create-channel-item"]')
      await menuItem3.waitFor({ timeout: 10000 })
      await menuItem3.click()
      await page.locator('[data-test="create-channel-dialog"]').waitFor({ timeout: 10000 })

      const longChannelName = 'a'.repeat(101)
      const nameInput = page.locator('[data-test="channel-name-input"]')
      await nameInput.fill(longChannelName)
      await expect(nameInput).toHaveValue(longChannelName)
      await page.locator('[data-test="create-channel-submit-button"]').click()

      // WHY: Client-side Zod schema has max(100). Dialog stays open with submit
      // button still present — validation prevented submission, no API call made.
      await expect(page.locator('[data-test="create-channel-dialog"]')).toBeVisible({
        timeout: 5000,
      })
      await expect(page.locator('[data-test="create-channel-submit-button"]')).toBeVisible()
    })
  })

  // ── Ban Reason Validation ───────────────────────────────────────

  test.describe('Ban Reason', () => {
    test('rejects ban reason exceeding 512 characters via API', async () => {
      const target = await createTestUser('val-ban-target')
      await syncProfile(target.token)

      // Create invite, join the server as target
      const invite = await createInvite(owner.token, server.id)
      await joinServer(target.token, server.id, invite.code)

      // Try to ban with a reason > 512 chars via API
      const banRes = await fetch(`http://localhost:3000/v1/servers/${server.id}/bans`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${owner.token}`,
        },
        body: JSON.stringify({
          userId: target.id,
          reason: 'r'.repeat(513),
        }),
      })

      expect(banRes.status).toBeGreaterThanOrEqual(400)
    })
  })

  // ── Invite Code Validation ──────────────────────────────────────

  test.describe('Invite Code', () => {
    test('rejects non-alphanumeric invite code', async () => {
      // WHY: Pure API test — the invite code format rule is enforced by the
      // Rust API (alphanumeric only, 1-32 chars). Using direct HTTP eliminates
      // flaky UI interactions (dialog open/fill/click) that caused intermittent
      // timeouts due to Supabase session refreshes detaching the DOM.
      const res = await fetch('http://localhost:3000/v1/invites/abc-def!@#')

      expect(res.status).toBeGreaterThanOrEqual(400)
    })

    test('rejects invite code exceeding 32 characters', async () => {
      // WHY: Pure API test — same rationale as above. The 32-char limit is a
      // server-side validation rule, not a client-side UX concern.
      const longCode = 'a'.repeat(33)
      const res = await fetch(`http://localhost:3000/v1/invites/${longCode}`)

      expect(res.status).toBeGreaterThanOrEqual(400)
    })
  })

  // ── Channel Topic Validation ────────────────────────────────────

  test.describe('Channel Topic', () => {
    test('rejects channel topic exceeding 1024 characters via API', async () => {
      const { items: channels } = await getServerChannels(owner.token, server.id)
      const channelId = channels[0].id

      // PATCH with oversized topic via API
      const res = await fetch(
        `http://localhost:3000/v1/servers/${server.id}/channels/${channelId}`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${owner.token}`,
          },
          body: JSON.stringify({
            topic: 't'.repeat(1025),
          }),
        },
      )

      expect(res.status).toBeGreaterThanOrEqual(400)
    })
  })
})
