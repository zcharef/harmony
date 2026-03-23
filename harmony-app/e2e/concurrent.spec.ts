import { expect, test } from '@playwright/test'
import { authenticatePage, selectChannel, selectServer } from './fixtures/auth-fixture'
import {
  createInvite,
  createServer,
  getServerChannels,
  joinServer,
  sendMessage,
  syncProfile,
} from './fixtures/test-data-factory'
import { createTestUser } from './fixtures/user-factory'

/**
 * Concurrent/Realtime access E2E tests.
 *
 * WHY only message delivery: The app currently subscribes to Realtime
 * postgres_changes on the `messages` table only (use-realtime-messages.ts).
 * Server membership, channel, and server changes do NOT propagate via Realtime.
 * Tests for those scenarios should be added when Realtime subscriptions are implemented.
 */

test.describe('Concurrent Access', () => {
  // ── Realtime Message Delivery ──────────────────────────────────

  test('User B sees message sent by User A via Realtime', async ({ page }) => {
    // Setup: two users in the same server/channel
    const userA = await createTestUser('conc-msg-a')
    const userB = await createTestUser('conc-msg-b')
    await syncProfile(userA.token)
    await syncProfile(userB.token)

    const server = await createServer(userA.token)
    const invite = await createInvite(userA.token, server.id)
    await joinServer(userB.token, server.id, invite.code)

    const { items: channels } = await getServerChannels(userA.token, server.id)
    const channelId = channels[0].id
    const channelName = channels[0].name

    // User B opens the channel in the browser
    await authenticatePage(page, userB)
    await selectServer(page, server.id)
    await selectChannel(page, channelName)

    // WHY: Wait for the chat area to mount — this triggers the Realtime subscription
    // setup (useRealtimeMessages). We also wait a beat for the WebSocket handshake
    // to complete before sending the message, otherwise the INSERT event may fire
    // before the subscription is ready to receive it.
    await page.locator('[data-test="chat-area"]').waitFor({ timeout: 10_000 })
    await page.waitForTimeout(2_000)

    // User A sends a message via API (not through browser UI).
    // WHY: Using a single browser page avoids browser.newContext() issues
    // (missing baseURL, viewport, flaky dual-context auth). The Realtime
    // delivery behavior is identical regardless of how the message was sent.
    const uniqueMessage = `realtime-test-${Date.now()}`
    await sendMessage(userA.token, channelId, uniqueMessage)

    // User B should see the message via Realtime INSERT event.
    // WHY: generous timeout because Realtime delivery latency is unpredictable
    // in local dev (Supabase Realtime has variable warm-up time).
    const messageOnB = page
      .locator('[data-test="message-content"]')
      .filter({ hasText: uniqueMessage })
    await expect(messageOnB).toBeVisible({ timeout: 20_000 })
  })
})
