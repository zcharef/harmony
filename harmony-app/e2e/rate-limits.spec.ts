import { expect, test } from '@playwright/test'
import { createDmRaw, syncProfile } from './fixtures/test-data-factory'
import { createTestUser, type TestUser } from './fixtures/user-factory'

/**
 * Rate limiting E2E tests.
 *
 * WHY only DM rate limit? The message rate limit (5 per 5s sliding window)
 * is inherently untestable in E2E: sequential sends take >5s in slow CI
 * (messages age out), concurrent sends suffer TOCTOU (all read count=0).
 * Message rate limiting is covered by Rust integration tests instead.
 *
 * The DM rate limit (10 per hour) uses a large window that doesn't suffer
 * from CI timing variance, making it reliably testable end-to-end.
 */

test.describe('Rate Limiting', () => {
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
