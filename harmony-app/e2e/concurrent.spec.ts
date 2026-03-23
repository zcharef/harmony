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

    // WHY: Capture the Realtime WebSocket BEFORE navigating so we can wait for
    // the subscription acknowledgment. Supabase Realtime sends a phx_reply with
    // status "ok" once postgres_changes is subscribed. Without this, the INSERT
    // event may fire before the subscription is ready — the root cause of the
    // previous test.skip.
    const wsPromise = page.waitForEvent('websocket', {
      predicate: (ws) => ws.url().includes('/realtime/'),
      timeout: 20_000,
    })

    // User B opens the channel in the browser
    await authenticatePage(page, userB)
    await selectServer(page, server.id)
    await selectChannel(page, channelName)

    // Wait for chat area mount (triggers useRealtimeMessages subscription)
    await page.locator('[data-test="chat-area"]').waitFor({ timeout: 10_000 })

    // WHY: Wait for the Realtime WebSocket to connect and confirm the
    // postgres_changes subscription is active. The server sends a phx_reply
    // frame with status:"ok" for the subscription join. We wait for this
    // specific frame to guarantee the channel is listening before we send.
    const ws = await wsPromise
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        // WHY: If subscription ack never arrives within 10s, proceed anyway.
        // The toPass assertion below has its own retry budget.
        resolve()
      }, 10_000)

      ws.on('framereceived', (frame) => {
        if (typeof frame.payload === 'string' && frame.payload.includes('"status":"ok"')) {
          clearTimeout(timeout)
          resolve()
        }
      })

      ws.on('close', () => {
        clearTimeout(timeout)
        reject(new Error('Realtime WebSocket closed before subscription confirmed'))
      })
    })

    // User A sends a message via API (not through browser UI).
    // WHY: Using a single browser page avoids browser.newContext() issues
    // (missing baseURL, viewport, flaky dual-context auth). The Realtime
    // delivery behavior is identical regardless of how the message was sent.
    const uniqueMessage = `realtime-test-${Date.now()}`
    await sendMessage(userA.token, channelId, uniqueMessage)

    // User B should see the message appear in the chat area.
    // WHY toPass: Realtime delivery latency in local Supabase is variable.
    // toPass retries the assertion block periodically (default 2s interval)
    // within the timeout budget, making this resilient to slow delivery
    // without requiring fragile fixed waits.
    const messageOnB = page
      .locator('[data-test="message-content"]')
      .filter({ hasText: uniqueMessage })
    await expect(messageOnB).toBeVisible({ timeout: 15_000 })
  })
})
