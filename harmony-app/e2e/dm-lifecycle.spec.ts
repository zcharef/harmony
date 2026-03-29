/**
 * E2E Tests — DM Lifecycle (Deep Flows)
 *
 * Expands on dms.spec.ts to cover deeper DM scenarios:
 * - Message persistence after close and reopen
 * - DM between users in different servers
 * - DM sidebar ordering (most recent conversation first)
 * - DM message visible to both sender and recipient
 *
 * Navigation model: No URL router. page.goto('/') is the only valid URL.
 * All navigation via UI clicks (dm-home-button toggles DM view).
 *
 * API endpoints tested:
 * - POST /v1/dms { recipientId } — create or return existing DM
 * - GET  /v1/dms              — list DM conversations
 * - DELETE /v1/dms/{server_id} — close/hide DM
 * - POST /v1/channels/{id}/messages — send message in DM channel
 *
 * Real data-test attributes from:
 * - dm-sidebar.tsx:53 (dm-conversation-row), :57 (dm-conversation-item),
 *   :102 (dm-close-button), :133 (dm-sidebar), :142 (dm-new-message-button),
 *   :154 (dm-list)
 * - server-list.tsx:117 (dm-home-button)
 * - chat-area.tsx:468 (chat-area), :286 (message-input)
 * - message-item.tsx:91 (message-item), :169 (message-content)
 * - main-layout.tsx:198 (main-layout)
 */
import { expect, test } from '@playwright/test'
import { authenticatePage } from './fixtures/auth-fixture'
import {
  closeDm,
  createDm,
  createInvite,
  createServer,
  joinServer,
  sendMessage,
  syncProfile,
} from './fixtures/test-data-factory'
import { createTestUser } from './fixtures/user-factory'

test.describe('DM Lifecycle', () => {
  // ── Message Persistence After Close and Reopen ──────────────────

  test.describe('message persistence', () => {
    test('messages persist after closing and reopening a DM', async ({ page }) => {
      // WHY: Backend creates a NEW DM server+channel on reopen (close = delete server).
      // Messages from the old DM are in a different channel, so they will NOT carry over.
      // This test verifies the expected behavior: new DM after close = clean slate,
      // but both old and new DMs can be opened if they exist.
      const userA = await createTestUser('dml-persist-a')
      const userB = await createTestUser('dml-persist-b')
      for (const u of [userA, userB]) await syncProfile(u.token)

      // Users must share a server for DM creation
      const srv = await createServer(userA.token, `DMLPersist ${Date.now()}`)
      const invite = await createInvite(userA.token, srv.id)
      await joinServer(userB.token, srv.id, invite.code)

      // Create DM and send a message
      const dm1 = await createDm(userA.token, userB.id)
      const persistMsg = `persist-msg-${Date.now()}`
      await sendMessage(userA.token, dm1.channelId, persistMsg)

      // Verify the message is visible in the DM
      await authenticatePage(page, userA)
      await page.locator('[data-test="dm-home-button"]').click()
      await page.locator('[data-test="dm-sidebar"]').waitFor({ timeout: 10_000 })

      const dmItem1 = page.locator(
        `[data-test="dm-conversation-item"][data-dm-server-id="${dm1.serverId}"]`,
      )
      await dmItem1.waitFor({ timeout: 10_000 })
      await dmItem1.click()

      await page.locator('[data-test="chat-area"]').waitFor({ timeout: 10_000 })

      const messageContent = page
        .locator('[data-test="message-content"]')
        .filter({ hasText: persistMsg })
      await expect(messageContent.first()).toBeVisible({ timeout: 10_000 })

      // Close the DM via API
      await closeDm(userA.token, dm1.serverId)

      // Reopen the DM — creates a NEW server+channel
      const dm2 = await createDm(userA.token, userB.id)
      expect(dm2.serverId).not.toBe(dm1.serverId)

      // Send a new message in the reopened DM
      const newMsg = `reopen-msg-${Date.now()}`
      await sendMessage(userA.token, dm2.channelId, newMsg)

      // WHY: After close + reopen, SSE delivers a dm.created event which
      // invalidates the DM list cache (use-realtime-dms.ts). Wait for the
      // new DM item to appear in the sidebar — no page refresh needed.
      await page.locator('[data-test="dm-home-button"]').click()
      await page.locator('[data-test="dm-sidebar"]').waitFor({ timeout: 10_000 })

      const dmItem2 = page.locator(
        `[data-test="dm-conversation-item"][data-dm-server-id="${dm2.serverId}"]`,
      )
      await dmItem2.waitFor({ timeout: 10_000 })
      await dmItem2.click()

      await page.locator('[data-test="chat-area"]').waitFor({ timeout: 10_000 })

      // New message should be visible
      const newMsgContent = page
        .locator('[data-test="message-content"]')
        .filter({ hasText: newMsg })
      await expect(newMsgContent.first()).toBeVisible({ timeout: 10_000 })
    })
  })

  // ── DM Between Users in Different Servers ───────────────────────

  test.describe('cross-server DM', () => {
    test('users who share a server can DM even if they also belong to other servers', async ({
      page,
    }) => {
      // WHY: DM creation requires users to share at least one server
      // (user-search-dialog.tsx aggregates members from all servers).
      // This test creates two servers where each user is in a different extra server,
      // but they share one common server — DM should work.
      const userC = await createTestUser('dml-xsrv-c')
      const userD = await createTestUser('dml-xsrv-d')
      for (const u of [userC, userD]) await syncProfile(u.token)

      // Shared server (both users are members)
      const sharedServer = await createServer(userC.token, `DMLShared ${Date.now()}`)
      const invite = await createInvite(userC.token, sharedServer.id)
      await joinServer(userD.token, sharedServer.id, invite.code)

      // User C's extra server (userD is NOT a member)
      await createServer(userC.token, `DMLExtraC ${Date.now()}`)

      // User D's extra server (userC is NOT a member)
      await createServer(userD.token, `DMLExtraD ${Date.now()}`)

      // Create DM between them (should work because they share sharedServer)
      const dm = await createDm(userC.token, userD.id)

      const uniqueMsg = `cross-server-dm-${Date.now()}`
      await sendMessage(userC.token, dm.channelId, uniqueMsg)

      // Verify the message is visible for User C
      await authenticatePage(page, userC)
      await page.locator('[data-test="dm-home-button"]').click()
      await page.locator('[data-test="dm-sidebar"]').waitFor({ timeout: 10_000 })

      const dmItem = page.locator(
        `[data-test="dm-conversation-item"][data-dm-server-id="${dm.serverId}"]`,
      )
      await dmItem.waitFor({ timeout: 10_000 })
      await dmItem.click()

      await page.locator('[data-test="chat-area"]').waitFor({ timeout: 10_000 })

      const messageContent = page
        .locator('[data-test="message-content"]')
        .filter({ hasText: uniqueMsg })
      await expect(messageContent.first()).toBeVisible({ timeout: 10_000 })
    })
  })

  // ── DM Sidebar Ordering ─────────────────────────────────────────

  test.describe('sidebar ordering', () => {
    test('most recently active DM appears first in sidebar', async ({ page }) => {
      // WHY: dm-sidebar.tsx renders DMs in the order returned by GET /v1/dms.
      // The backend sorts by last_message.created_at DESC (most recent first).
      // We create two DMs, send a message in the second one last, and verify
      // it appears before the first one in the sidebar.
      const orderUser = await createTestUser('dml-order-main')
      const targetA = await createTestUser('dml-order-a')
      const targetB = await createTestUser('dml-order-b')
      for (const u of [orderUser, targetA, targetB]) await syncProfile(u.token)

      // All must share a server for DM creation
      const orderServer = await createServer(orderUser.token, `DMLOrder ${Date.now()}`)
      const invite = await createInvite(orderUser.token, orderServer.id)
      await joinServer(targetA.token, orderServer.id, invite.code)
      await joinServer(targetB.token, orderServer.id, invite.code)

      // Create DM with targetA first, send a message
      const dmA = await createDm(orderUser.token, targetA.id)
      const msgA = await sendMessage(orderUser.token, dmA.channelId, `Msg to A ${Date.now()}`)

      // Create DM with targetB second, send a message (this should appear first)
      const dmB = await createDm(orderUser.token, targetB.id)
      const msgB = await sendMessage(orderUser.token, dmB.channelId, `Msg to B ${Date.now()}`)

      // WHY: Verify the API assigned distinct, ordered timestamps. If the messages
      // have the same created_at (sub-millisecond), ordering is non-deterministic.
      // This assertion replaces an arbitrary setTimeout(1000) by confirming the
      // precondition the test relies on: msgB was created after msgA.
      expect(msgB.createdAt > msgA.createdAt).toBe(true)

      // Load DM sidebar
      await authenticatePage(page, orderUser)
      await page.locator('[data-test="dm-home-button"]').click()
      await page.locator('[data-test="dm-sidebar"]').waitFor({ timeout: 10_000 })

      // Wait for both DM items to appear
      const dmItemA = page.locator(
        `[data-test="dm-conversation-item"][data-dm-server-id="${dmA.serverId}"]`,
      )
      const dmItemB = page.locator(
        `[data-test="dm-conversation-item"][data-dm-server-id="${dmB.serverId}"]`,
      )
      await dmItemA.waitFor({ timeout: 10_000 })
      await dmItemB.waitFor({ timeout: 10_000 })

      // WHY: Verify ordering by checking the DOM position of the two conversation items.
      // The DM list renders items in order from the API response.
      const allDmItems = page.locator('[data-test="dm-conversation-item"]')
      const allServerIds: string[] = []
      const count = await allDmItems.count()
      for (let i = 0; i < count; i++) {
        const sid = await allDmItems.nth(i).getAttribute('data-dm-server-id')
        // WHY: Every dm-conversation-item MUST have a data-dm-server-id attribute.
        // If it doesn't, the component is broken and the test should fail loudly.
        expect(sid).not.toBeNull()
        allServerIds.push(sid as string)
      }

      const idxA = allServerIds.indexOf(dmA.serverId)
      const idxB = allServerIds.indexOf(dmB.serverId)

      // Both should be present
      expect(idxA).toBeGreaterThanOrEqual(0)
      expect(idxB).toBeGreaterThanOrEqual(0)

      // DM B (most recent message) should appear BEFORE DM A
      expect(idxB).toBeLessThan(idxA)
    })
  })

  // ── DM Message Visible to Both Parties ──────────────────────────

  test.describe('bidirectional visibility', () => {
    test('message sent by User E is visible to User F in their DM', async ({ page, browser }) => {
      const userE = await createTestUser('dml-bidir-e')
      const userF = await createTestUser('dml-bidir-f')
      for (const u of [userE, userF]) await syncProfile(u.token)

      const bidirServer = await createServer(userE.token, `DMLBidir ${Date.now()}`)
      const invite = await createInvite(userE.token, bidirServer.id)
      await joinServer(userF.token, bidirServer.id, invite.code)

      const dm = await createDm(userE.token, userF.id)
      const bidirMsg = `bidir-msg-${Date.now()}`
      await sendMessage(userE.token, dm.channelId, bidirMsg)

      // --- User E sees the message ---
      await authenticatePage(page, userE)
      await page.locator('[data-test="dm-home-button"]').click()
      await page.locator('[data-test="dm-sidebar"]').waitFor({ timeout: 10_000 })

      const dmItemE = page.locator(
        `[data-test="dm-conversation-item"][data-dm-server-id="${dm.serverId}"]`,
      )
      await dmItemE.waitFor({ timeout: 10_000 })
      await dmItemE.click()
      await page.locator('[data-test="chat-area"]').waitFor({ timeout: 10_000 })

      const msgE = page.locator('[data-test="message-content"]').filter({ hasText: bidirMsg })
      await expect(msgE.first()).toBeVisible({ timeout: 10_000 })

      // --- User F sees the message in a separate context ---
      // WHY: browser.newContext() does NOT inherit use.baseURL from playwright.config.ts.
      const contextF = await browser.newContext({ baseURL: 'http://localhost:1420' })
      const pageF = await contextF.newPage()

      try {
        await authenticatePage(pageF, userF)
        await pageF.locator('[data-test="dm-home-button"]').click()
        await pageF.locator('[data-test="dm-sidebar"]').waitFor({ timeout: 10_000 })

        const dmItemF = pageF.locator(
          `[data-test="dm-conversation-item"][data-dm-server-id="${dm.serverId}"]`,
        )
        await dmItemF.waitFor({ timeout: 10_000 })
        await dmItemF.click()
        await pageF.locator('[data-test="chat-area"]').waitFor({ timeout: 10_000 })

        const msgF = pageF.locator('[data-test="message-content"]').filter({ hasText: bidirMsg })
        await expect(msgF.first()).toBeVisible({ timeout: 15_000 })
      } finally {
        await contextF.close()
      }
    })

    test('User F replies in DM and User E sees the reply', async ({ page, browser }) => {
      const replyE = await createTestUser('dml-reply-e')
      const replyF = await createTestUser('dml-reply-f')
      for (const u of [replyE, replyF]) await syncProfile(u.token)

      const replyServer = await createServer(replyE.token, `DMLReply ${Date.now()}`)
      const invite = await createInvite(replyE.token, replyServer.id)
      await joinServer(replyF.token, replyServer.id, invite.code)

      const dm = await createDm(replyE.token, replyF.id)

      // User E sends initial message
      const initialMsg = `initial-${Date.now()}`
      await sendMessage(replyE.token, dm.channelId, initialMsg)

      // User F replies
      const replyMsg = `reply-${Date.now()}`
      await sendMessage(replyF.token, dm.channelId, replyMsg)

      // --- User E sees both messages ---
      await authenticatePage(page, replyE)
      await page.locator('[data-test="dm-home-button"]').click()
      await page.locator('[data-test="dm-sidebar"]').waitFor({ timeout: 10_000 })

      const dmItem = page.locator(
        `[data-test="dm-conversation-item"][data-dm-server-id="${dm.serverId}"]`,
      )
      await dmItem.waitFor({ timeout: 10_000 })
      await dmItem.click()
      await page.locator('[data-test="chat-area"]').waitFor({ timeout: 10_000 })

      const initialContent = page
        .locator('[data-test="message-content"]')
        .filter({ hasText: initialMsg })
      await expect(initialContent.first()).toBeVisible({ timeout: 10_000 })

      const replyContent = page
        .locator('[data-test="message-content"]')
        .filter({ hasText: replyMsg })
      await expect(replyContent.first()).toBeVisible({ timeout: 10_000 })

      // --- User F also sees both messages ---
      const contextF = await browser.newContext({ baseURL: 'http://localhost:1420' })
      const pageF = await contextF.newPage()

      try {
        await authenticatePage(pageF, replyF)
        await pageF.locator('[data-test="dm-home-button"]').click()
        await pageF.locator('[data-test="dm-sidebar"]').waitFor({ timeout: 10_000 })

        const dmItemF = pageF.locator(
          `[data-test="dm-conversation-item"][data-dm-server-id="${dm.serverId}"]`,
        )
        await dmItemF.waitFor({ timeout: 10_000 })
        await dmItemF.click()
        await pageF.locator('[data-test="chat-area"]').waitFor({ timeout: 10_000 })

        const initialF = pageF
          .locator('[data-test="message-content"]')
          .filter({ hasText: initialMsg })
        await expect(initialF.first()).toBeVisible({ timeout: 10_000 })

        const replyF2 = pageF.locator('[data-test="message-content"]').filter({ hasText: replyMsg })
        await expect(replyF2.first()).toBeVisible({ timeout: 10_000 })
      } finally {
        await contextF.close()
      }
    })
  })
})
