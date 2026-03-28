import { expect, test } from '@playwright/test'
import {
  createDm,
  createDmRaw,
  createServer,
  getServerChannels,
  sendMessageRaw,
  syncProfile,
} from './fixtures/test-data-factory'
import { createTestUser, type TestUser } from './fixtures/user-factory'

/**
 * Rate limiting E2E tests.
 *
 * WHY API-only: Rate limits are enforced by the Rust API, not the UI.
 * Testing via direct API calls is deterministic and fast. UI-based message
 * sending adds ~200ms per message (fill + Enter + response), which can push
 * 6 messages outside the 5-second window and cause false passes/failures.
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
    let channelId: string

    test.beforeAll(async () => {
      sender = await createTestUser('rate-msg-sender')
      await syncProfile(sender.token)
      const server = await createServer(sender.token)
      const { items: channels } = await getServerChannels(sender.token, server.id)
      channelId = channels[0].id
    })

    test('messages beyond the rate limit are rejected with 429', async () => {
      // WHY: Send 8 messages concurrently. The rate limit is 5 per 5s per channel.
      // With 8 concurrent requests, the server receives them nearly simultaneously —
      // at least 3 must be rate-limited. We assert at least one 429 response exists
      // rather than checking a specific position, because HTTP request ordering is
      // non-deterministic at the network layer.
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          sendMessageRaw(sender.token, channelId, `rate-burst-${i + 1}-${Date.now()}`),
        ),
      )

      const statuses = results.map((r) => r.status)
      const rateLimitedCount = statuses.filter((s) => s === 429).length

      // At least one request must have been rate-limited
      expect(rateLimitedCount).toBeGreaterThanOrEqual(1)
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
      // Attempt 11th DM via factory — should be rate limited
      const { status } = await createDmRaw(dmCreator.token, targets[10].id)
      expect(status).toBe(429)
    })
  })
})
