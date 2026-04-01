/**
 * E2E Tests — SSE Reliability & DM Real-Time Delivery
 *
 * Tests the critical SSE failure mode where DMs created AFTER the SSE
 * connection is established have their server_id missing from the server-side
 * snapshot (events.rs:57-68). Without the reconnect fix, MessageCreated events
 * for these DMs are silently dropped.
 *
 * These tests are NOT redundant with realtime-sync.spec.ts or dms.spec.ts:
 * - realtime-sync.spec.ts creates DMs in beforeAll (snapshot includes them)
 * - dms.spec.ts tests DM CRUD, not live SSE delivery with stale snapshots
 *
 * SSE events exercised:
 * - message.created: useRealtimeMessages inserts new message into cache
 * - dm.created: useRealtimeDms invalidates DM list + triggers reconnect
 *
 * Real data-test attributes from:
 * - main-layout.tsx (main-layout, data-test-sse-status)
 * - connection-banner.tsx (connection-banner)
 * - server-list.tsx:117 (dm-home-button)
 * - dm-sidebar.tsx (dm-sidebar, dm-conversation-item, dm-list)
 * - chat-area.tsx:468 (chat-area), :475 (message-list), :286 (message-input)
 * - message-item.tsx:169 (message-content)
 */
import { expect, type Page, test } from '@playwright/test'
import { authenticatePage } from './fixtures/auth-fixture'
import {
  createDm,
  createInvite,
  createServer,
  joinServer,
  sendMessage,
  syncProfile,
} from './fixtures/test-data-factory'
import { createTestUser, type TestUser } from './fixtures/user-factory'

// ── Helpers ───────────────────────────────────────────────────────

/**
 * Navigates to a DM conversation by clicking through the DM sidebar.
 * Waits for chat-area and message-list to confirm the channel is fully loaded
 * and useRealtimeMessages is subscribed to SSE events.
 */
async function openDmConversation(page: Page, dmServerId: string) {
  await page.locator('[data-test="dm-home-button"]').click()
  await page.locator('[data-test="dm-sidebar"]').waitFor({ timeout: 10_000 })
  const dmItem = page.locator(
    `[data-test="dm-conversation-item"][data-dm-server-id="${dmServerId}"]`,
  )
  await dmItem.waitFor({ timeout: 15_000 })
  await dmItem.click()
  await page.locator('[data-test="chat-area"]').waitFor({ timeout: 10_000 })
  await page.locator('[data-test="message-list"]').waitFor({ timeout: 10_000 })
}

/**
 * Waits for the SSE connection to be fully established after a reconnect cycle.
 *
 * WHY: After requestReconnect(), the EventSource tears down and re-creates.
 * Simply checking that the connection-banner is hidden is unreliable because
 * the AnimatePresence exit animation (300ms) may still be in progress when
 * the assertion fires. Instead, we assert on the `data-test-sse-status`
 * attribute on main-layout, which reflects the Zustand store value directly
 * without animation interference.
 */
async function waitForSseConnected(page: Page) {
  await expect(page.locator('[data-test="main-layout"]')).toHaveAttribute(
    'data-test-sse-status',
    'connected',
    { timeout: 15_000 },
  )
}

// ── Tests ─────────────────────────────────────────────────────────

test.describe('SSE Reliability — DM created during active session', () => {
  let userA: TestUser
  let userB: TestUser
  let server: { id: string; name: string }

  test.beforeAll(async () => {
    userA = await createTestUser('sse-dm-a')
    userB = await createTestUser('sse-dm-b')
    for (const u of [userA, userB]) await syncProfile(u.token)

    // WHY: Both users must share a server for DM eligibility.
    server = await createServer(userA.token, `SSE DM E2E ${Date.now()}`)
    const invite = await createInvite(userA.token, server.id)
    await joinServer(userB.token, server.id, invite.code)
  })

  test('creator receives messages sent by recipient in post-connect DM', async ({ browser }) => {
    // WHY: This is the primary bug regression test. Both users have active SSE
    // connections when the DM is created. The creator's SSE snapshot does NOT
    // include the new DM server_id. Without the requestReconnect() fix in
    // use-create-dm.ts, MessageCreated events for UserB's messages would be
    // silently dropped by the server_ids filter (events.rs:125-129).
    //
    // Direction: UserB sends → UserA receives. This tests the CREATOR's
    // snapshot refresh. Sender-exclusion (events.rs:144) prevents UserB from
    // receiving their own event, so UserA is the one who must receive it.
    const contextA = await browser.newContext({ baseURL: 'http://localhost:1420' })
    const contextB = await browser.newContext({ baseURL: 'http://localhost:1420' })
    const pageA = await contextA.newPage()
    const pageB = await contextB.newPage()

    try {
      // Both users authenticate — SSE connections established
      await authenticatePage(pageA, userA)
      await authenticatePage(pageB, userB)

      // Create DM AFTER both SSE connections are active
      const dm = await createDm(userA.token, userB.id)

      // WHY: The fix triggers requestReconnect() on both sides:
      // - Creator (userA): via use-create-dm.ts onSuccess
      // - Recipient (userB): via use-realtime-dms.ts handleDmCreated
      // Wait for both reconnects to complete before navigating.
      await waitForSseConnected(pageA)
      await waitForSseConnected(pageB)

      // Both users navigate to the new DM
      await openDmConversation(pageA, dm.serverId)
      await openDmConversation(pageB, dm.serverId)

      // UserB sends a message via the UI
      const uniqueMessage = `sse-creator-recv-${Date.now()}`
      const messageInput = pageB.locator('[data-test="message-input"]')
      await messageInput.fill(uniqueMessage)
      await messageInput.press('Enter')

      // UserB sees their own message (optimistic UI)
      const sentOnB = pageB
        .locator('[data-test="message-content"]')
        .filter({ hasText: uniqueMessage })
      await expect(sentOnB.first()).toBeVisible({ timeout: 10_000 })

      // UserA sees the message via SSE — no navigation, no reload
      const receivedOnA = pageA
        .locator('[data-test="message-content"]')
        .filter({ hasText: uniqueMessage })
      await expect(receivedOnA).toBeVisible({ timeout: 15_000 })
    } finally {
      await contextA.close()
      await contextB.close()
    }
  })

  test('recipient receives messages sent by creator in post-connect DM', async ({ browser }) => {
    // WHY: Tests the RECIPIENT's snapshot refresh. The recipient's SSE
    // connection received a dm.created event (target_user_id routing), which
    // triggers requestReconnect() in use-realtime-dms.ts. After reconnect,
    // the new SSE connection's list_all_memberships() includes the DM server.
    //
    // Direction: UserA sends → UserB receives. Sender-exclusion filters out
    // UserA's own message on UserA's stream. UserB must receive it via SSE.
    const contextA = await browser.newContext({ baseURL: 'http://localhost:1420' })
    const contextB = await browser.newContext({ baseURL: 'http://localhost:1420' })
    const pageA = await contextA.newPage()
    const pageB = await contextB.newPage()

    try {
      await authenticatePage(pageA, userA)
      await authenticatePage(pageB, userB)

      // Create DM after SSE connections are active
      const dm = await createDm(userA.token, userB.id)

      // Wait for reconnects
      await waitForSseConnected(pageA)
      await waitForSseConnected(pageB)

      // Navigate to the DM
      await openDmConversation(pageA, dm.serverId)
      await openDmConversation(pageB, dm.serverId)

      // UserA sends a message via the UI
      const uniqueMessage = `sse-recipient-recv-${Date.now()}`
      const messageInput = pageA.locator('[data-test="message-input"]')
      await messageInput.fill(uniqueMessage)
      await messageInput.press('Enter')

      // UserA sees their own message (optimistic UI)
      const sentOnA = pageA
        .locator('[data-test="message-content"]')
        .filter({ hasText: uniqueMessage })
      await expect(sentOnA.first()).toBeVisible({ timeout: 10_000 })

      // UserB sees the message via SSE
      const receivedOnB = pageB
        .locator('[data-test="message-content"]')
        .filter({ hasText: uniqueMessage })
      await expect(receivedOnB).toBeVisible({ timeout: 15_000 })
    } finally {
      await contextA.close()
      await contextB.close()
    }
  })
})

test.describe('SSE Reliability — DM creation race conditions', () => {
  test('DM created before recipient SSE connects — appears on initial load', async ({
    browser,
  }) => {
    // WHY: Tests the "event published to zero receivers" gap. UserA creates a
    // DM and sends a message while UserB has no SSE connection. The DmCreated
    // event is published but UserB isn't subscribed. When UserB later connects,
    // list_all_memberships() includes the DM server_id (it was created before
    // connect), so SSE routing works. But the DmCreated event itself was lost.
    // The DM must appear via the initial GET /v1/dms fetch, and the message
    // via the initial GET /v1/channels/{id}/messages query.
    const userA = await createTestUser('sse-race-a')
    const userB = await createTestUser('sse-race-b')
    for (const u of [userA, userB]) await syncProfile(u.token)

    const srv = await createServer(userA.token, `SSE Race E2E ${Date.now()}`)
    const invite = await createInvite(userA.token, srv.id)
    await joinServer(userB.token, srv.id, invite.code)

    // UserA authenticates and creates DM + sends message while UserB is offline
    const contextA = await browser.newContext({ baseURL: 'http://localhost:1420' })
    const pageA = await contextA.newPage()
    await authenticatePage(pageA, userA)

    const dm = await createDm(userA.token, userB.id)
    const uniqueMessage = `sse-race-msg-${Date.now()}`
    await sendMessage(userA.token, dm.channelId, uniqueMessage)

    // NOW UserB connects — after DM and message already exist
    const contextB = await browser.newContext({ baseURL: 'http://localhost:1420' })
    const pageB = await contextB.newPage()

    try {
      await authenticatePage(pageB, userB)

      // Navigate to DM home — the DM should appear via GET /v1/dms
      await pageB.locator('[data-test="dm-home-button"]').click()
      await pageB.locator('[data-test="dm-sidebar"]').waitFor({ timeout: 10_000 })

      const dmItem = pageB.locator(
        `[data-test="dm-conversation-item"][data-dm-server-id="${dm.serverId}"]`,
      )
      await expect(dmItem).toBeVisible({ timeout: 15_000 })

      // Click into the DM and verify the message is visible
      await dmItem.click()
      await pageB.locator('[data-test="chat-area"]').waitFor({ timeout: 10_000 })

      const messageContent = pageB
        .locator('[data-test="message-content"]')
        .filter({ hasText: uniqueMessage })
      await expect(messageContent.first()).toBeVisible({ timeout: 15_000 })
    } finally {
      await contextA.close()
      await contextB.close()
    }
  })
})

test.describe('SSE Reliability — DM conversation isolation', () => {
  let userA: TestUser
  let userB: TestUser
  let userC: TestUser
  let dmAB: { serverId: string; channelId: string }
  let dmAC: { serverId: string; channelId: string }

  test.beforeAll(async () => {
    userA = await createTestUser('sse-iso-a')
    userB = await createTestUser('sse-iso-b')
    userC = await createTestUser('sse-iso-c')
    for (const u of [userA, userB, userC]) await syncProfile(u.token)

    const srv = await createServer(userA.token, `SSE Iso E2E ${Date.now()}`)
    const invite = await createInvite(userA.token, srv.id)
    await joinServer(userB.token, srv.id, invite.code)
    await joinServer(userC.token, srv.id, invite.code)

    // WHY: Create both DMs before page load so SSE snapshots include them.
    // This test is about message routing isolation, not the snapshot bug.
    dmAB = await createDm(userA.token, userB.id)
    dmAC = await createDm(userA.token, userC.id)

    // Seed a message in DM(A,B) so it appears in the sidebar
    await sendMessage(userA.token, dmAB.channelId, 'Seed message AB')
    // Seed a message in DM(A,C) so it appears in the sidebar
    await sendMessage(userA.token, dmAC.channelId, 'Seed message AC')
  })

  test('message in one DM does not leak into another DM chat view', async ({ page }) => {
    // WHY: Tests that useRealtimeMessages's channelId filter correctly isolates
    // messages. When UserA is viewing DM(A,B), a message sent in DM(A,C) should
    // NOT appear in the current chat view. This is not covered by any existing test.
    await authenticatePage(page, userA)

    // Open DM with UserB
    await openDmConversation(page, dmAB.serverId)

    // Verify seed message is visible
    const seedMsg = page
      .locator('[data-test="message-content"]')
      .filter({ hasText: 'Seed message AB' })
    await expect(seedMsg.first()).toBeVisible({ timeout: 10_000 })

    // UserC sends a message in DM(A,C) via API while UserA is viewing DM(A,B)
    const leakTestMsg = `isolation-check-${Date.now()}`
    await sendMessage(userC.token, dmAC.channelId, leakTestMsg)

    // WHY: Wait long enough for the SSE event to arrive and be processed.
    // If the channelId filter is broken, the message would appear here.
    // 3 seconds is generous — SSE delivery is typically <500ms in local dev.
    await page.waitForTimeout(3_000)

    // Assert: The message from DM(A,C) does NOT appear in DM(A,B) chat
    const leakedMsg = page.locator('[data-test="message-content"]').filter({ hasText: leakTestMsg })
    await expect(leakedMsg).toHaveCount(0)

    // Navigate to DM with UserC and verify the message IS there
    await openDmConversation(page, dmAC.serverId)

    const correctMsg = page
      .locator('[data-test="message-content"]')
      .filter({ hasText: leakTestMsg })
    await expect(correctMsg.first()).toBeVisible({ timeout: 15_000 })
  })
})

test.describe('SSE Reliability — Bidirectional exchange in post-connect DM', () => {
  test('both users can send and receive in a DM created after SSE connection', async ({
    browser,
  }) => {
    // WHY: The ultimate integration test. Proves that BOTH users' SSE snapshots
    // are refreshed after DM creation, sender-exclusion works correctly for
    // both sides, and messages flow bidirectionally through the SSE pipeline.
    const userA = await createTestUser('sse-bidir-a')
    const userB = await createTestUser('sse-bidir-b')
    for (const u of [userA, userB]) await syncProfile(u.token)

    const srv = await createServer(userA.token, `SSE Bidir E2E ${Date.now()}`)
    const invite = await createInvite(userA.token, srv.id)
    await joinServer(userB.token, srv.id, invite.code)

    const contextA = await browser.newContext({ baseURL: 'http://localhost:1420' })
    const contextB = await browser.newContext({ baseURL: 'http://localhost:1420' })
    const pageA = await contextA.newPage()
    const pageB = await contextB.newPage()

    try {
      // Both users authenticate — SSE connections established
      await authenticatePage(pageA, userA)
      await authenticatePage(pageB, userB)

      // Create DM after both SSE connections are active
      const dm = await createDm(userA.token, userB.id)

      // Wait for both reconnects to complete
      await waitForSseConnected(pageA)
      await waitForSseConnected(pageB)

      // Both navigate to the DM
      await openDmConversation(pageA, dm.serverId)
      await openDmConversation(pageB, dm.serverId)

      // --- Round 1: UserA sends, UserB receives ---
      const msgFromA = `bidir-from-A-${Date.now()}`
      const inputA = pageA.locator('[data-test="message-input"]')
      await inputA.fill(msgFromA)
      await inputA.press('Enter')

      // UserA sees own message (optimistic)
      await expect(
        pageA.locator('[data-test="message-content"]').filter({ hasText: msgFromA }).first(),
      ).toBeVisible({ timeout: 10_000 })

      // UserB sees message via SSE
      await expect(
        pageB.locator('[data-test="message-content"]').filter({ hasText: msgFromA }),
      ).toBeVisible({ timeout: 15_000 })

      // --- Round 2: UserB replies, UserA receives ---
      const msgFromB = `bidir-from-B-${Date.now()}`
      const inputB = pageB.locator('[data-test="message-input"]')
      await inputB.fill(msgFromB)
      await inputB.press('Enter')

      // UserB sees own reply (optimistic)
      await expect(
        pageB.locator('[data-test="message-content"]').filter({ hasText: msgFromB }).first(),
      ).toBeVisible({ timeout: 10_000 })

      // UserA sees reply via SSE
      await expect(
        pageA.locator('[data-test="message-content"]').filter({ hasText: msgFromB }),
      ).toBeVisible({ timeout: 15_000 })

      // --- Verify order on both pages ---
      // WHY: Both messages should be visible and in chronological order on both pages.
      const allContentsA = await pageA.locator('[data-test="message-content"]').allTextContents()
      const idxAonA = allContentsA.findIndex((t) => t.includes(msgFromA))
      const idxBonA = allContentsA.findIndex((t) => t.includes(msgFromB))
      expect(idxAonA).toBeGreaterThanOrEqual(0)
      expect(idxBonA).toBeGreaterThanOrEqual(0)
      expect(idxAonA).toBeLessThan(idxBonA)

      const allContentsB = await pageB.locator('[data-test="message-content"]').allTextContents()
      const idxAonB = allContentsB.findIndex((t) => t.includes(msgFromA))
      const idxBonB = allContentsB.findIndex((t) => t.includes(msgFromB))
      expect(idxAonB).toBeGreaterThanOrEqual(0)
      expect(idxBonB).toBeGreaterThanOrEqual(0)
      expect(idxAonB).toBeLessThan(idxBonB)
    } finally {
      await contextA.close()
      await contextB.close()
    }
  })
})
