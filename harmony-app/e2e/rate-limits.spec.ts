import { expect, test } from '@playwright/test'
import { authenticatePage, selectChannel, selectServer } from './fixtures/auth-fixture'
import {
  createDm,
  createServer,
  getServerChannels,
  syncProfile,
} from './fixtures/test-data-factory'
import { createTestUser, type TestUser } from './fixtures/user-factory'

/**
 * Rate limiting E2E tests.
 *
 * Verified limits (from domain services):
 * - Messages: 5 per 5 seconds per user per channel (MessageService::RATE_LIMIT_MAX)
 * - DMs: 10 new DMs per hour per user (DmService MAX_DMS_PER_HOUR)
 * - Global API: 300 requests per 60 seconds per user (RateLimitLayer)
 */

test.describe('Rate Limiting', () => {
  // ── Message Rate Limit (5 per 5s per channel) ──────────────────

  test.describe('Message Rate Limit', () => {
    let sender: TestUser
    let server: { id: string; name: string }
    let channelName: string

    test.beforeAll(async () => {
      sender = await createTestUser('rate-msg-sender')
      await syncProfile(sender.token)
      server = await createServer(sender.token)
      const { items: channels } = await getServerChannels(sender.token, server.id)
      channelName = channels[0].name
    })

    test('6th message within 5 seconds is rate-limited', async ({ page }) => {
      // WHY: authenticatePage already navigates to '/' and waits for main-layout.
      // Avoid redundant page.goto('/') which causes a reload race condition.
      await authenticatePage(page, sender)
      await selectServer(page, server.id)
      await selectChannel(page, channelName)
      await page.locator('[data-test="chat-area"]').waitFor({ timeout: 10000 })

      const messageInput = page.locator('[data-test="message-input"]')
      const responses: number[] = []

      // Send 6 messages rapidly
      for (let i = 1; i <= 6; i++) {
        const content = `rate-test-msg-${i}-${Date.now()}`
        await messageInput.fill(content)

        const responsePromise = page.waitForResponse(
          (response) =>
            response.url().includes('/messages') && response.request().method() === 'POST',
        )

        await messageInput.press('Enter')

        const response = await responsePromise
        responses.push(response.status())
      }

      // First 5 should succeed (2xx), 6th should be rate-limited (429)
      const successCount = responses.filter((s) => s >= 200 && s < 300).length
      const rateLimitedCount = responses.filter((s) => s === 429).length

      expect(successCount).toBe(5)
      expect(rateLimitedCount).toBe(1)
    })
  })

  // ── DM Creation Rate Limit (10 per hour) ───────────────────────

  test.describe('DM Creation Rate Limit', () => {
    let dmCreator: TestUser
    let targets: TestUser[]

    test.beforeAll(async () => {
      dmCreator = await createTestUser('rate-dm-creator')
      await syncProfile(dmCreator.token)

      // Create 11 target users for DM creation
      targets = []
      for (let i = 0; i < 11; i++) {
        const target = await createTestUser(`rate-dm-target-${i}`)
        await syncProfile(target.token)
        targets.push(target)
      }

      // Create first 10 DMs via API (fast setup)
      for (let i = 0; i < 10; i++) {
        await createDm(dmCreator.token, targets[i].id)
      }
    })

    test('11th DM creation within an hour is rate-limited', async () => {
      // Attempt 11th DM via API — should be rate limited
      const API_URL = process.env.VITE_API_URL ?? 'http://localhost:3000'

      const res = await fetch(`${API_URL}/v1/dms`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${dmCreator.token}`,
        },
        body: JSON.stringify({ recipientId: targets[10].id }),
      })

      expect(res.status).toBe(429)
    })
  })
})
