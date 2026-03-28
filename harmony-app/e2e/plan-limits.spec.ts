import { expect, test } from '@playwright/test'
import { authenticatePage, selectServer } from './fixtures/auth-fixture'
import {
  createChannel,
  createChannelRaw,
  createServer,
  syncProfile,
} from './fixtures/test-data-factory'
import { createTestUser, type TestUser } from './fixtures/user-factory'

/**
 * Plan Limits E2E tests.
 *
 * Validates that server-level plan limits are enforced by the API and that
 * the error response uses RFC 9457 ProblemDetails with an upgrade_url field.
 *
 * Free plan limits under test:
 *   §3 Channels: 50 per server
 *   §2 Members: 150 per server (not tested — too expensive to create 150 users)
 *
 * All tests use real API calls — no mocks, no direct DB access.
 */
test.describe('Plan Limits — Channel Enforcement (§3)', () => {
  // WHY: beforeAll creates 49 channels sequentially (~1s each) which exceeds
  // the default 45s test timeout. 120s gives headroom for CI latency.
  test.setTimeout(120_000)

  let owner: TestUser
  let server: { id: string; name: string }

  // WHY: beforeAll creates 49 channels sequentially. At ~1s per API call
  // against Supabase Cloud, this needs more than the default 45s timeout.
  test.beforeAll(async () => {
    test.setTimeout(120_000)

    // WHY: Create a fresh user + server for limit testing.
    // The server starts with plan='free' (DB default) and 1 auto-created #general channel.
    owner = await createTestUser('plan-limit')
    await syncProfile(owner.token)
    server = await createServer(owner.token, `limit-test-${Date.now()}`)

    // WHY: Fill the server to exactly the free limit (50 channels).
    // Server already has 1 (#general), so we create 49 more.
    // Sequential to avoid TOCTOU race in the COUNT-before-POST limit check.
    for (let i = 1; i <= 49; i++) {
      await createChannel(owner.token, server.id, `fill-${i}`)
    }
  })

  // ── API rejects the 51st channel with 403 + RFC 9457 ────────────────

  test('API returns 403 with upgrade_url when channel limit is exceeded', async () => {
    // ACT: Try to create the 51st channel (free limit = 50)
    const result = await createChannelRaw(owner.token, server.id, 'over-limit')

    // ASSERT: 403 Forbidden with ProblemDetails
    expect(result.status).toBe(403)

    const body = result.body as Record<string, unknown>
    expect(body).toHaveProperty('type', 'about:blank')
    expect(body).toHaveProperty('title', 'Plan Limit Exceeded')
    expect(body).toHaveProperty('status', 403)

    // RFC 9457 detail message mentions the plan, limit, and resource
    const detail = body.detail as string
    expect(detail).toContain('free')
    expect(detail).toContain('50')
    expect(detail).toContain('channels')

    // upgrade_url drives the upsell CTA
    expect(body).toHaveProperty('upgrade_url')
    const upgradeUrl = body.upgrade_url as string
    expect(upgradeUrl).toContain('pricing')
  })

  // ── UI shows error feedback when channel limit is exceeded ──────────

  test('UI shows error when creating a channel beyond the limit', async ({ page }) => {
    // WHY: authenticatePage already navigates to / and waits for main-layout.
    // A redundant page.goto('/') causes a full SPA reload that races with
    // the Supabase session recovery, producing net::ERR_FAILED on API calls.
    await authenticatePage(page, owner)
    await selectServer(page, server.id)

    // Verify all 50 channels are visible
    const channelButtons = page.locator('[data-test="channel-button"]')
    await channelButtons.first().waitFor({ timeout: 10_000 })
    await expect(channelButtons).toHaveCount(50, { timeout: 10_000 })

    // Open server menu and click "Create Channel"
    await page.locator('[data-test="server-header-button"]').click()
    // WHY: Wait for dropdown to render — HeroUI dropdown has animation delay.
    const createChannelItem = page.locator('[data-test="server-menu-create-channel-item"]')
    await createChannelItem.waitFor({ timeout: 5_000 })
    await createChannelItem.click()

    // Fill create channel form
    const dialog = page.locator('[data-test="create-channel-dialog"]')
    await expect(dialog).toBeVisible({ timeout: 5_000 })

    const nameInput = page.locator('[data-test="channel-name-input"]')
    await nameInput.fill('over-limit-ui')
    await expect(nameInput).toHaveValue('over-limit-ui')

    // Submit and wait for API response (expect 403)
    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/v1/servers/${server.id}/channels`) &&
        response.request().method() === 'POST',
    )

    await page.locator('[data-test="create-channel-submit-button"]').click()

    const response = await responsePromise
    expect(response.status()).toBe(403)

    // Verify response body has upgrade_url
    const body = await response.json()
    expect(body).toHaveProperty('title', 'Plan Limit Exceeded')
    expect(body).toHaveProperty('upgrade_url')

    // Channel count should NOT have increased (auto-retrying assertion)
    await expect(channelButtons).toHaveCount(50, { timeout: 5_000 })
  })

  // ── Verify the limit is exactly 50 (50 succeeds, 51 fails) ─────────

  test('channel 50 succeeds but channel 51 fails on a fresh server', async () => {
    // WHY: Verifies the boundary condition — exactly at the limit vs one over.
    const freshServer = await createServer(owner.token, `boundary-${Date.now()}`)

    // Create 48 channels (server starts with 1 = #general, so total will be 49).
    // Sequential to avoid TOCTOU race in the COUNT-before-POST limit check.
    for (let i = 1; i <= 48; i++) {
      await createChannel(owner.token, freshServer.id, `b-${i}`)
    }

    // Channel 50 (the 49th we create) should succeed
    const channel50 = await createChannelRaw(owner.token, freshServer.id, 'b-49')
    expect(channel50.status).toBe(201)

    // Channel 51 should fail
    const channel51 = await createChannelRaw(owner.token, freshServer.id, 'b-50')
    expect(channel51.status).toBe(403)

    const body = channel51.body as Record<string, unknown>
    expect(body).toHaveProperty('title', 'Plan Limit Exceeded')
  })
})
