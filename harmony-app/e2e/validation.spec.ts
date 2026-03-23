import { expect, test } from '@playwright/test'
import { authenticatePage, selectChannel, selectServer } from './fixtures/auth-fixture'
import {
  createInvite,
  createServer,
  getServerChannels,
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
 * - Message content: 1-4000 chars after trim
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

      await page.locator('[data-test="add-server-button"]').click()
      await page.locator('[data-test="create-server-dialog"]').waitFor({ timeout: 10000 })

      // Leave name empty, submit
      const nameInput = page.locator('[data-test="server-name-input"]')
      await nameInput.fill('')
      await page.locator('[data-test="create-server-submit-button"]').click()

      // Dialog should stay open (form validation prevents submission)
      await expect(page.locator('[data-test="create-server-dialog"]')).toBeVisible({ timeout: 5000 })
    })

    test('rejects server name exceeding 100 characters', async ({ page }) => {
      await authenticatePage(page, owner)

      await page.locator('[data-test="add-server-button"]').click()
      await page.locator('[data-test="create-server-dialog"]').waitFor({ timeout: 10000 })

      const longName = 'a'.repeat(101)
      const nameInput = page.locator('[data-test="server-name-input"]')
      await nameInput.fill(longName)

      await page.locator('[data-test="create-server-submit-button"]').click()

      // WHY: Client-side Zod schema has max(100). The zodResolver catches the
      // error before handleSubmit fires, so no POST request is ever made.
      // Dialog stays open with a validation error — no API call needed.
      await expect(page.locator('[data-test="create-server-dialog"]')).toBeVisible({ timeout: 5000 })
    })

    test('rejects server name with control characters via API', async ({ page }) => {
      await authenticatePage(page, owner)

      await page.locator('[data-test="add-server-button"]').click()
      await page.locator('[data-test="create-server-dialog"]').waitFor({ timeout: 10000 })

      // Control char U+0009 (tab) — client form accepts it (no regex), but API rejects it
      const nameWithControlChar = 'Server\tName'
      const nameInput = page.locator('[data-test="server-name-input"]')
      await nameInput.fill(nameWithControlChar)

      const responsePromise = page.waitForResponse(
        (response) =>
          response.url().includes('/v1/servers') && response.request().method() === 'POST',
      )

      await page.locator('[data-test="create-server-submit-button"]').click()

      const response = await responsePromise
      expect(response.status()).toBeGreaterThanOrEqual(400)

      await expect(page.locator('[data-test="create-server-dialog"]')).toBeVisible({ timeout: 5000 })
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
      await page.locator('[data-test="create-channel-submit-button"]').click()

      // Client-side Zod regex rejects uppercase — dialog stays open with error
      await expect(page.locator('[data-test="create-channel-dialog"]')).toBeVisible({ timeout: 5000 })
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
      await page.locator('[data-test="create-channel-submit-button"]').click()

      // Regex ^[a-z0-9-]+$ rejects underscore and exclamation
      await expect(page.locator('[data-test="create-channel-dialog"]')).toBeVisible({ timeout: 5000 })
    })

    test('rejects channel name exceeding 100 characters', async ({ page }) => {
      await authenticatePage(page, owner)
      await selectServer(page, server.id)

      await page.locator('[data-test="server-header-button"]').click()
      const menuItem3 = page.locator('[data-test="server-menu-create-channel-item"]')
      await menuItem3.waitFor({ timeout: 10000 })
      await menuItem3.click()
      await page.locator('[data-test="create-channel-dialog"]').waitFor({ timeout: 10000 })

      const nameInput = page.locator('[data-test="channel-name-input"]')
      await nameInput.fill('a'.repeat(101))
      await page.locator('[data-test="create-channel-submit-button"]').click()

      // Zod max(100) rejects — dialog stays open
      await expect(page.locator('[data-test="create-channel-dialog"]')).toBeVisible({ timeout: 5000 })
    })
  })

  // ── Message Content Validation ──────────────────────────────────

  test.describe('Message Content', () => {
    let channelName: string

    test.beforeAll(async () => {
      const { items: channels } = await getServerChannels(owner.token, server.id)
      channelName = channels[0].name
    })

    test('rejects empty message — does not send', async ({ page }) => {
      await authenticatePage(page, owner)
      await selectServer(page, server.id)
      await selectChannel(page, channelName)

      await page.locator('[data-test="chat-area"]').waitFor({ timeout: 10000 })

      const messageInput = page.locator('[data-test="message-input"]')
      await messageInput.fill('   ')

      // Press Enter — client-side trim check prevents API call
      await messageInput.press('Enter')

      // WHY: Give the UI a tick to process the Enter keypress before asserting
      // absence. Without this, the assertion may pass vacuously before any
      // potential (buggy) message render completes.
      await page.waitForTimeout(500)

      // Whitespace-only should not trigger API call
      // Verify message did not appear in the list
      const messageContents = page.locator('[data-test="message-content"]')
      const count = await messageContents.filter({ hasText: '   ' }).count()
      expect(count).toBe(0)
    })

    test('rejects message exceeding 4000 characters via API', async ({ page }) => {
      await authenticatePage(page, owner)
      await selectServer(page, server.id)
      await selectChannel(page, channelName)

      await page.locator('[data-test="chat-area"]').waitFor({ timeout: 10000 })

      const longMessage = 'x'.repeat(4001)
      const messageInput = page.locator('[data-test="message-input"]')
      await messageInput.fill(longMessage)

      const responsePromise = page.waitForResponse(
        (response) =>
          response.url().includes('/messages') && response.request().method() === 'POST',
      )

      await messageInput.press('Enter')

      const response = await responsePromise
      expect(response.status()).toBeGreaterThanOrEqual(400)
    })
  })

  // ── Ban Reason Validation ───────────────────────────────────────

  test.describe('Ban Reason', () => {
    test('rejects ban reason exceeding 512 characters via API', async ({ page: _page }) => {
      const target = await createTestUser('val-ban-target')
      await syncProfile(target.token)

      // Create invite, join the server as target
      const invite = await createInvite(owner.token, server.id)
      const previewRes = await fetch(`http://localhost:3000/v1/invites/${invite.code}`)
      const preview = (await previewRes.json()) as { serverId: string }
      await fetch(`http://localhost:3000/v1/servers/${preview.serverId}/members`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${target.token}`,
        },
        body: JSON.stringify({ inviteCode: invite.code }),
      })

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
    test('rejects non-alphanumeric invite code', async ({ page }) => {
      await authenticatePage(page, owner)

      await page.locator('[data-test="join-server-button"]').click()
      await page.locator('[data-test="join-server-dialog"]').waitFor({ timeout: 10000 })

      const codeInput = page.locator('[data-test="invite-code-input"]')
      await codeInput.fill('abc-def!@#')

      // WHY: Set up response listener BEFORE the click to avoid a race where
      // the API response arrives before the listener is registered.
      const responsePromise = page.waitForResponse(
        (response) =>
          response.url().includes('/v1/invites') && response.request().method() === 'GET',
      )

      await page.locator('[data-test="join-server-preview-button"]').click()

      const response = await responsePromise
      expect(response.status()).toBeGreaterThanOrEqual(400)

      // API validation rejects non-alphanumeric codes — error shows in dialog
      await expect(page.locator('[data-test="join-server-dialog"]')).toBeVisible({ timeout: 5000 })
    })

    test('rejects invite code exceeding 32 characters', async ({ page }) => {
      await authenticatePage(page, owner)

      await page.locator('[data-test="join-server-button"]').click()
      await page.locator('[data-test="join-server-dialog"]').waitFor({ timeout: 10000 })

      const longCode = 'a'.repeat(33)
      const codeInput = page.locator('[data-test="invite-code-input"]')
      await codeInput.fill(longCode)

      // WHY: Set up response listener BEFORE the click to avoid a race where
      // the API response arrives before the listener is registered.
      const responsePromise = page.waitForResponse(
        (response) =>
          response.url().includes('/v1/invites') && response.request().method() === 'GET',
      )

      await page.locator('[data-test="join-server-preview-button"]').click()

      const response = await responsePromise
      expect(response.status()).toBeGreaterThanOrEqual(400)

      // API rejects codes > 32 chars — dialog stays open
      await expect(page.locator('[data-test="join-server-dialog"]')).toBeVisible({ timeout: 5000 })
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
