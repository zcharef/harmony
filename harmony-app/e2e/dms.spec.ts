/**
 * E2E Tests — Direct Messages
 *
 * Verifies DM creation (context menu + user search), message exchange between
 * two users, close/reopen flow preserving history, self-DM blocking, and rate
 * limiting.
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
 * - dm-sidebar.tsx:53 (dm-conversation-item), :95 (dm-close-button),
 *   :131 (dm-sidebar), :140 (dm-new-message-button), :152 (dm-list)
 * - user-search-dialog.tsx:110 (user-search-dialog), :120 (user-search-input),
 *   :147 (user-search-result)
 * - server-list.tsx:117 (dm-home-button)
 * - chat-area.tsx:286 (message-input), :468 (chat-area), :475 (message-list)
 * - message-item.tsx:91 (message-item), :169 (message-content)
 * - member-list.tsx:242 (member-item)
 * - member-context-menu.tsx:168 (send-message-item)
 * - main-layout.tsx:198 (main-layout)
 */
import { expect, test } from '@playwright/test'
import { authenticatePage, selectServer } from './fixtures/auth-fixture'
import {
  closeDm,
  createDm,
  createDmRaw,
  createInvite,
  createServer,
  joinServer,
  sendMessage,
  syncProfile,
} from './fixtures/test-data-factory'
import { createTestUser, type TestUser } from './fixtures/user-factory'

test.describe('Direct Messages', () => {
  let userA: TestUser
  let userB: TestUser
  let server: { id: string; name: string }

  test.beforeAll(async () => {
    userA = await createTestUser('dm-userA')
    userB = await createTestUser('dm-userB')
    for (const u of [userA, userB]) await syncProfile(u.token)

    // WHY: Both users must share a server so they appear in each other's
    // user search dialog (user-search-dialog.tsx aggregates members from all servers).
    server = await createServer(userA.token, `DM E2E ${Date.now()}`)
    const invite = await createInvite(userA.token, server.id)
    await joinServer(userB.token, server.id, invite.code)
  })

  test('create DM from member context menu — DM appears in sidebar', async ({ page }) => {
    await authenticatePage(page, userA)
    await page.goto('/')
    await page.locator('[data-test="main-layout"]').waitFor({ timeout: 15_000 })
    await selectServer(page, server.id)

    const memberList = page.locator('[data-test="member-list"]')
    await memberList.waitFor({ timeout: 10_000 })

    // Right-click userB to open context menu
    const targetItem = memberList.locator(`[data-test="member-item"][data-user-id="${userB.id}"]`)
    await targetItem.waitFor({ timeout: 10_000 })
    await page.keyboard.press('Escape')
    await targetItem.click({ button: 'right' })
    await page.locator('[data-test="member-context-menu"]').waitFor({ timeout: 5_000 })

    // Click "Send Message" — creates DM and navigates to DM view
    const dmResponsePromise = page.waitForResponse(
      (response) => response.url().includes('/v1/dms') && response.request().method() === 'POST',
    )

    const sendMessageItem = page.locator('[data-test="send-message-item"]')
    await sendMessageItem.waitFor({ timeout: 5_000 })
    await sendMessageItem.click()

    const dmResponse = await dmResponsePromise
    expect(dmResponse.status()).toBeLessThan(400)

    // WHY: main-layout.tsx:150 switches to DM view on handleNavigateDm,
    // which renders DmSidebar. Verify DM sidebar is now visible.
    const dmSidebar = page.locator('[data-test="dm-sidebar"]')
    await dmSidebar.waitFor({ timeout: 10_000 })

    // Verify the DM conversation item appears in the sidebar
    const dmItem = page.locator('[data-test="dm-conversation-item"]')
    await expect(dmItem.first()).toBeVisible({ timeout: 10_000 })

    // Verify chat area is loaded for the DM
    await expect(page.locator('[data-test="chat-area"]')).toBeVisible({ timeout: 10_000 })
  })

  test('create DM from user search — DM appears in sidebar', async ({ page }) => {
    // WHY: Use a fresh user pair to avoid interference with context menu test.
    const searchUserA = await createTestUser('dm-search-a')
    const searchUserB = await createTestUser('dm-search-b')
    for (const u of [searchUserA, searchUserB]) await syncProfile(u.token)

    const searchServer = await createServer(searchUserA.token, `DM Search E2E ${Date.now()}`)
    const invite = await createInvite(searchUserA.token, searchServer.id)
    await joinServer(searchUserB.token, searchServer.id, invite.code)

    await authenticatePage(page, searchUserA)
    await page.goto('/')
    await page.locator('[data-test="main-layout"]').waitFor({ timeout: 15_000 })

    // Navigate to DM view via the home button
    const dmHomeButton = page.locator('[data-test="dm-home-button"]')
    await dmHomeButton.click()

    const dmSidebar = page.locator('[data-test="dm-sidebar"]')
    await dmSidebar.waitFor({ timeout: 10_000 })

    // Click "New Message" button to open user search dialog
    await page.locator('[data-test="dm-new-message-button"]').click()

    const searchDialog = page.locator('[data-test="user-search-dialog"]')
    await expect(searchDialog).toBeVisible({ timeout: 5_000 })

    // WHY: user-search-dialog.tsx:87 filters out current user, so searchUserB should appear.
    // Wait for search results to load (users are fetched from shared servers).
    const searchResults = page.locator('[data-test="user-search-result"]')
    await searchResults.first().waitFor({ timeout: 10_000 })

    // Click the target user to create DM
    const dmResponsePromise = page.waitForResponse(
      (response) => response.url().includes('/v1/dms') && response.request().method() === 'POST',
    )

    await page.locator(`[data-test="user-search-result"][data-user-id="${searchUserB.id}"]`).click()

    const dmResponse = await dmResponsePromise
    expect(dmResponse.status()).toBeLessThan(400)

    // Dialog should close and DM conversation should appear in sidebar
    await expect(searchDialog).not.toBeVisible({ timeout: 5_000 })

    const dmItem = page.locator('[data-test="dm-conversation-item"]')
    await expect(dmItem.first()).toBeVisible({ timeout: 10_000 })
  })

  test('send message in DM — appears for both users', async ({ page, browser }) => {
    // WHY: Creates a fresh DM via API, sends a message as userA through the UI,
    // then verifies userB sees it in a separate browser context.
    const msgUserA = await createTestUser('dm-msg-a')
    const msgUserB = await createTestUser('dm-msg-b')
    for (const u of [msgUserA, msgUserB]) await syncProfile(u.token)

    const msgServer = await createServer(msgUserA.token, `DM Msg E2E ${Date.now()}`)
    const invite = await createInvite(msgUserA.token, msgServer.id)
    await joinServer(msgUserB.token, msgServer.id, invite.code)

    // Create DM via API so both users have it
    const dm = await createDm(msgUserA.token, msgUserB.id)

    const uniqueMessage = `Hello from E2E DM test ${Date.now()}`

    // --- User A sends a message via UI ---
    await authenticatePage(page, msgUserA)
    await page.goto('/')
    await page.locator('[data-test="main-layout"]').waitFor({ timeout: 15_000 })

    // Navigate to DM view
    await page.locator('[data-test="dm-home-button"]').click()
    await page.locator('[data-test="dm-sidebar"]').waitFor({ timeout: 10_000 })

    // Select the DM conversation
    const dmItem = page.locator(
      `[data-test="dm-conversation-item"][data-dm-server-id="${dm.serverId}"]`,
    )
    await dmItem.waitFor({ timeout: 10_000 })
    await dmItem.click()

    // Wait for chat area to load
    await page.locator('[data-test="chat-area"]').waitFor({ timeout: 10_000 })

    // Send the message
    const messageInput = page.locator('[data-test="message-input"]')
    await messageInput.fill(uniqueMessage)

    const sendResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/v1/channels/${dm.channelId}/messages`) &&
        response.request().method() === 'POST',
    )

    await messageInput.press('Enter')

    const sendResponse = await sendResponsePromise
    expect(sendResponse.status()).toBeLessThan(400)

    // Verify message appears for User A
    const messageContent = page
      .locator('[data-test="message-content"]')
      .filter({ hasText: uniqueMessage })
    await expect(messageContent.first()).toBeVisible({ timeout: 10_000 })

    // --- User B opens a new page and sees the message ---
    const contextB = await browser.newContext()
    const pageB = await contextB.newPage()

    await authenticatePage(pageB, msgUserB)
    await pageB.goto('/')
    await pageB.locator('[data-test="main-layout"]').waitFor({ timeout: 15_000 })

    // Navigate to DM view
    await pageB.locator('[data-test="dm-home-button"]').click()
    await pageB.locator('[data-test="dm-sidebar"]').waitFor({ timeout: 10_000 })

    // Select the same DM conversation
    const dmItemB = pageB.locator(
      `[data-test="dm-conversation-item"][data-dm-server-id="${dm.serverId}"]`,
    )
    await dmItemB.waitFor({ timeout: 10_000 })
    await dmItemB.click()

    await pageB.locator('[data-test="chat-area"]').waitFor({ timeout: 10_000 })

    // Verify message appears for User B
    const messageContentB = pageB
      .locator('[data-test="message-content"]')
      .filter({ hasText: uniqueMessage })
    await expect(messageContentB.first()).toBeVisible({ timeout: 15_000 })

    await contextB.close()
  })

  test('close DM — disappears from sidebar', async ({ page }) => {
    const closeUserA = await createTestUser('dm-close-a')
    const closeUserB = await createTestUser('dm-close-b')
    for (const u of [closeUserA, closeUserB]) await syncProfile(u.token)

    const closeServer = await createServer(closeUserA.token, `DM Close E2E ${Date.now()}`)
    const invite = await createInvite(closeUserA.token, closeServer.id)
    await joinServer(closeUserB.token, closeServer.id, invite.code)

    // Create DM and send a message so it appears in the sidebar
    const dm = await createDm(closeUserA.token, closeUserB.id)
    await sendMessage(closeUserA.token, dm.channelId, 'Message before close')

    await authenticatePage(page, closeUserA)
    await page.goto('/')
    await page.locator('[data-test="main-layout"]').waitFor({ timeout: 15_000 })

    // Navigate to DM view
    await page.locator('[data-test="dm-home-button"]').click()
    await page.locator('[data-test="dm-sidebar"]').waitFor({ timeout: 10_000 })

    // Verify DM item is visible
    const dmItem = page.locator(
      `[data-test="dm-conversation-item"][data-dm-server-id="${dm.serverId}"]`,
    )
    await dmItem.waitFor({ timeout: 10_000 })

    // Close DM via the X button (hover to reveal, then click)
    // WHY: dm-sidebar.tsx:93 — dm-close-button is inside a group with opacity-0,
    // visible on group-hover. We hover the parent row first.
    const dmRow = dmItem.locator('..')
    await dmRow.hover()

    const closeResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/v1/dms/${dm.serverId}`) &&
        response.request().method() === 'DELETE',
    )

    const closeButton = dmRow.locator('[data-test="dm-close-button"]')
    await closeButton.click({ force: true })

    const closeResponse = await closeResponsePromise
    expect(closeResponse.status()).toBeLessThan(400)

    // Verify DM item is no longer visible
    await expect(dmItem).not.toBeVisible({ timeout: 10_000 })
  })

  test('reopen DM — previous messages still visible', async ({ page }) => {
    const reopenUserA = await createTestUser('dm-reopen-a')
    const reopenUserB = await createTestUser('dm-reopen-b')
    for (const u of [reopenUserA, reopenUserB]) await syncProfile(u.token)

    const reopenServer = await createServer(reopenUserA.token, `DM Reopen E2E ${Date.now()}`)
    const invite = await createInvite(reopenUserA.token, reopenServer.id)
    await joinServer(reopenUserB.token, reopenServer.id, invite.code)

    // Create DM, send messages, then close via API
    const dm = await createDm(reopenUserA.token, reopenUserB.id)
    const uniqueMsg = `Persist check ${Date.now()}`
    await sendMessage(reopenUserA.token, dm.channelId, uniqueMsg)
    await closeDm(reopenUserA.token, dm.serverId)

    // Reopen DM via API (idempotent — returns same DM server)
    const reopened = await createDm(reopenUserA.token, reopenUserB.id)

    await authenticatePage(page, reopenUserA)
    await page.goto('/')
    await page.locator('[data-test="main-layout"]').waitFor({ timeout: 15_000 })

    // Navigate to DM view
    await page.locator('[data-test="dm-home-button"]').click()
    await page.locator('[data-test="dm-sidebar"]').waitFor({ timeout: 10_000 })

    // Select the reopened DM
    const dmItem = page.locator(
      `[data-test="dm-conversation-item"][data-dm-server-id="${reopened.serverId}"]`,
    )
    await dmItem.waitFor({ timeout: 10_000 })
    await dmItem.click()

    await page.locator('[data-test="chat-area"]').waitFor({ timeout: 10_000 })

    // Verify the previous message is still there
    const messageContent = page
      .locator('[data-test="message-content"]')
      .filter({ hasText: uniqueMsg })
    await expect(messageContent.first()).toBeVisible({ timeout: 15_000 })
  })

  test('cannot create DM with yourself — API returns 400', async () => {
    // WHY: dm_service.rs:83-87 blocks self-DM at the domain level.
    // This is an API-level test — no UI interaction needed because the
    // user-search-dialog.tsx:87 filters out the current user from results.
    const selfUser = await createTestUser('dm-self')
    await syncProfile(selfUser.token)

    const result = await createDmRaw(selfUser.token, selfUser.id)
    expect(result.status).toBe(400)
  })

  test('DM rate limit — creating >10 DMs/hour returns 429', async () => {
    // WHY: dm_service.rs:129-136 enforces MAX_DMS_PER_HOUR = 10.
    // Only NEW DM creation counts; reopening existing DMs is free.
    const rateLimitUser = await createTestUser('dm-ratelimit')
    await syncProfile(rateLimitUser.token)

    // Create 10 unique targets (each needs a profile to be a valid recipient)
    const targets: TestUser[] = []
    for (let i = 0; i < 11; i++) {
      const target = await createTestUser(`dm-rl-target-${i}`)
      await syncProfile(target.token)
      targets.push(target)
    }

    // Create 10 DMs (should all succeed)
    for (let i = 0; i < 10; i++) {
      const result = await createDmRaw(rateLimitUser.token, targets[i].id)
      expect(result.status).toBeLessThan(400)
    }

    // The 11th should be rate-limited (429)
    const result = await createDmRaw(rateLimitUser.token, targets[10].id)
    expect(result.status).toBe(429)
  })
})
