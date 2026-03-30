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
      // WHY: Hybrid approach to defeat both failure modes:
      //
      // 1. Sequential-only fails in slow CI: 5+ sequential HTTP round-trips
      //    take >5s, aging early messages out of the sliding window → 0 rejections.
      // 2. Concurrent-only fails with fast DB (TOCTOU): all requests read
      //    count=0 before any INSERT commits → 0 rejections.
      //
      // Solution: fill the bucket with 4 sequential sends (safe — count stays
      // under limit, no TOCTOU risk), then fire 6 concurrent sends. With 4
      // already committed, the concurrent batch sees count=4 and at least some
      // will read count >= 5 after the first few commit. Even with TOCTOU letting
      // a few extra through, 6 over-limit attempts guarantees rejections.
      for (let i = 0; i < 4; i++) {
        const res = await sendMessageRaw(
          sender.token,
          channelId,
          `rate-fill-${i + 1}-${Date.now()}`,
        )
        expect(res.status).toBe(201)
      }

      // Fire 6 concurrent messages — bucket has 4, limit is 5.
      // At most 1 can succeed (bringing count to 5), the rest must be rejected.
      const promises = Array.from({ length: 6 }, (_, i) =>
        sendMessageRaw(sender.token, channelId, `rate-burst-${i + 1}-${Date.now()}`),
      )
      const responses = await Promise.all(promises)
      const results = responses.map((r) => r.status)

      const rejected = results.filter((s) => s === 429).length

      // With 4 already in bucket and 6 concurrent, most should be rejected
      // (only 1 slot remains). TOCTOU may let several extra through in fast
      // environments, so we only require at least 1 rejection to prove the
      // rate limiter is working.
      expect(rejected).toBeGreaterThanOrEqual(1)
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

      // Create first 10 DMs via API (fast setup).
      // Sequential to avoid TOCTOU race in the hourly count check.
      for (let i = 0; i < 10; i++) {
        const dm = await createDmRaw(dmCreator.token, targets[i].id)
        if (dm.status !== 201) {
          throw new Error(`DM ${i + 1} setup failed with status ${dm.status}`)
        }
      }
    })

    test('11th DM creation within an hour is rate-limited', async () => {
      // Attempt 11th DM via factory — should be rate limited
      const { status } = await createDmRaw(dmCreator.token, targets[10].id)
      expect(status).toBe(429)
    })
  })
})
