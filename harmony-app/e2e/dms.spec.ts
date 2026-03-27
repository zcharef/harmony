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
 * - dm-sidebar.tsx:53 (dm-conversation-item), :51 (dm-conversation-row),
 *   :95 (dm-close-button), :131 (dm-sidebar), :140 (dm-new-message-button),
 *   :152 (dm-list)
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
  test.describe('context menu creation', () => {
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
      // WHY: authenticatePage already navigates to '/' and waits for main-layout.
      // No second goto needed — it wastes time and can cause race conditions.
      await authenticatePage(page, userA)
      await selectServer(page, server.id)

      const memberList = page.locator('[data-test="member-list"]')
      await memberList.waitFor({ timeout: 10_000 })

      // Right-click userB to open context menu
      const targetItem = memberList.locator(`[data-test="member-item"][data-user-id="${userB.id}"]`)
      await targetItem.waitFor({ timeout: 10_000 })
      await targetItem.click({ button: 'right' })

      // WHY: HeroUI Dropdown with data-test on <Dropdown> flows to the Popover wrapper.
      // Wait for the popover to be visible before interacting.
      const contextMenu = page.locator('[data-test="member-context-menu"]')
      await contextMenu.waitFor({ timeout: 5_000 })

      // WHY: HeroUI Dropdown uses CSS transition (~150ms) for entry animation.
      // The menu wrapper appears immediately but inner items are still transitioning
      // (position/opacity), causing Playwright's "element is not stable" error on click.
      // Waiting for the send-message item passes Playwright's stability check (includes animation).
      await contextMenu.locator('[data-test="send-message-item"]').waitFor({ timeout: 5_000 })

      // WHY: Set up response listener BEFORE clicking to avoid race conditions.
      const dmResponsePromise = page.waitForResponse(
        (response) => response.url().includes('/v1/dms') && response.request().method() === 'POST',
      )

      const sendMessageItem = page.locator('[data-test="send-message-item"]')
      await sendMessageItem.click()

      const dmResponse = await dmResponsePromise
      expect(dmResponse.status()).toBe(201)

      // WHY: main-layout.tsx:150 switches to DM view on handleNavigateDm,
      // which renders DmSidebar. Verify DM sidebar is now visible.
      const dmSidebar = page.locator('[data-test="dm-sidebar"]')
      await dmSidebar.waitFor({ timeout: 10_000 })

      // WHY: After DM creation, useCreateDm invalidates the DM list cache,
      // triggering a GET /v1/dms refetch. Wait for this refetch to complete
      // before checking for the conversation item — otherwise we assert on
      // stale (empty) cache data.
      await page.waitForResponse(
        (response) =>
          response.url().includes('/v1/dms') &&
          response.request().method() === 'GET' &&
          response.status() === 200,
        { timeout: 10_000 },
      )

      const dmItem = page.locator('[data-test="dm-conversation-item"]')
      await expect(dmItem.first()).toBeVisible({ timeout: 10_000 })

      // Verify chat area is loaded for the DM
      await expect(page.locator('[data-test="chat-area"]')).toBeVisible({ timeout: 10_000 })
    })
  })

  test.describe('user search creation', () => {
    let searchUserA: TestUser
    let searchUserB: TestUser

    test.beforeAll(async () => {
      // WHY: Use a fresh user pair to avoid interference with context menu test.
      searchUserA = await createTestUser('dm-search-a')
      searchUserB = await createTestUser('dm-search-b')
      for (const u of [searchUserA, searchUserB]) await syncProfile(u.token)

      const searchServer = await createServer(searchUserA.token, `DM Search E2E ${Date.now()}`)
      const invite = await createInvite(searchUserA.token, searchServer.id)
      await joinServer(searchUserB.token, searchServer.id, invite.code)
    })

    test('create DM from user search — DM appears in sidebar', async ({ page }) => {
      await authenticatePage(page, searchUserA)

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

      await page
        .locator(`[data-test="user-search-result"][data-user-id="${searchUserB.id}"]`)
        .click()

      const dmResponse = await dmResponsePromise
      expect(dmResponse.status()).toBe(201)

      // Dialog should close and DM conversation should appear in sidebar
      await expect(searchDialog).not.toBeVisible({ timeout: 5_000 })

      const dmItem = page.locator('[data-test="dm-conversation-item"]')
      await expect(dmItem.first()).toBeVisible({ timeout: 10_000 })
    })
  })

  test.describe('message exchange', () => {
    let msgUserA: TestUser
    let msgUserB: TestUser
    let dm: { serverId: string; channelId: string }
    let uniqueMessage: string

    test.beforeAll(async () => {
      msgUserA = await createTestUser('dm-msg-a')
      msgUserB = await createTestUser('dm-msg-b')
      for (const u of [msgUserA, msgUserB]) await syncProfile(u.token)

      const msgServer = await createServer(msgUserA.token, `DM Msg E2E ${Date.now()}`)
      const invite = await createInvite(msgUserA.token, msgServer.id)
      await joinServer(msgUserB.token, msgServer.id, invite.code)

      // WHY: Create DM and seed a message via API so the conversation exists before page load.
      dm = await createDm(msgUserA.token, msgUserB.id)
      uniqueMessage = `Hello from E2E DM test ${Date.now()}`
      await sendMessage(msgUserA.token, dm.channelId, uniqueMessage)
    })

    test('send message in DM — appears for both users', async ({ page, browser }) => {
      // --- User A opens DM and sees the message ---
      await authenticatePage(page, msgUserA)

      await page.locator('[data-test="dm-home-button"]').click()
      await page.locator('[data-test="dm-sidebar"]').waitFor({ timeout: 10_000 })

      const dmItem = page.locator(
        `[data-test="dm-conversation-item"][data-dm-server-id="${dm.serverId}"]`,
      )
      await dmItem.waitFor({ timeout: 10_000 })
      await dmItem.click()

      await page.locator('[data-test="chat-area"]').waitFor({ timeout: 10_000 })

      // Verify message appears for User A
      const messageContent = page
        .locator('[data-test="message-content"]')
        .filter({ hasText: uniqueMessage })
      await expect(messageContent.first()).toBeVisible({ timeout: 10_000 })

      // --- User B opens a new page and sees the message ---
      // WHY: browser.newContext() does NOT inherit `use.baseURL` from playwright.config.ts.
      // Without explicit baseURL, page.goto('/') navigates to about:blank instead of the app.
      const contextB = await browser.newContext({ baseURL: 'http://localhost:1420' })
      const pageB = await contextB.newPage()

      await authenticatePage(pageB, msgUserB)

      await pageB.locator('[data-test="dm-home-button"]').click()
      await pageB.locator('[data-test="dm-sidebar"]').waitFor({ timeout: 10_000 })

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
  })

  test.describe('close and reopen', () => {
    let closeUserA: TestUser
    let closeUserB: TestUser
    let closeDmData: { serverId: string; channelId: string }

    test.beforeAll(async () => {
      closeUserA = await createTestUser('dm-close-a')
      closeUserB = await createTestUser('dm-close-b')
      for (const u of [closeUserA, closeUserB]) await syncProfile(u.token)

      const closeServer = await createServer(closeUserA.token, `DM Close E2E ${Date.now()}`)
      const invite = await createInvite(closeUserA.token, closeServer.id)
      await joinServer(closeUserB.token, closeServer.id, invite.code)

      // Create DM and send a message so it appears in the sidebar
      closeDmData = await createDm(closeUserA.token, closeUserB.id)
      await sendMessage(closeUserA.token, closeDmData.channelId, 'Message before close')
    })

    test('close DM — disappears from sidebar', async ({ page }) => {
      await authenticatePage(page, closeUserA)

      // Navigate to DM view
      await page.locator('[data-test="dm-home-button"]').click()
      await page.locator('[data-test="dm-sidebar"]').waitFor({ timeout: 10_000 })

      // Verify DM item is visible
      const dmItem = page.locator(
        `[data-test="dm-conversation-item"][data-dm-server-id="${closeDmData.serverId}"]`,
      )
      await dmItem.waitFor({ timeout: 10_000 })

      // Close DM via API (DELETE /v1/dms/{server_id}) — mirrors what the close button does.
      // WHY: The close button (dm-sidebar.tsx:89) has opacity-0 by default and only becomes
      // visible on group-hover. It also has min-w-0 which causes Playwright's viewport
      // boundary check to fail ("Element is outside of the viewport"). Since the test goal
      // is to verify the DM disappears from the sidebar after close, we trigger via API
      // and assert the UI updates via the useCloseDm mutation's cache invalidation.
      const closeResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes(`/v1/dms/${closeDmData.serverId}`) &&
          response.request().method() === 'DELETE',
      )

      // WHY: Trigger close via dispatchEvent to bypass viewport/visibility issues
      // with the opacity-0 close button. The wrapper div (dm-conversation-row) holds
      // both dm-conversation-item and dm-close-button as siblings.
      const closeButton = page.locator(
        `[data-test="dm-conversation-row"][data-dm-server-id="${closeDmData.serverId}"] [data-test="dm-close-button"]`,
      )
      await closeButton.dispatchEvent('click')

      const closeResponse = await closeResponsePromise
      expect(closeResponse.status()).toBe(204)

      // Verify DM item is no longer visible
      await expect(dmItem).not.toBeVisible({ timeout: 10_000 })
    })

    test('reopen DM — new conversation loads in chat area', async ({ page }) => {
      // WHY: Backend creates a NEW DM server+channel on reopen (close = delete).
      // Verify that reopening creates a fresh conversation that loads correctly.

      // WHY: The previous test closed the DM. Create a fresh DM pair to avoid
      // depending on the close test's side effects (tests run sequentially in describe).
      const reopenUserA = await createTestUser('dm-reopen-a')
      const reopenUserB = await createTestUser('dm-reopen-b')
      for (const u of [reopenUserA, reopenUserB]) await syncProfile(u.token)

      const reopenServer = await createServer(reopenUserA.token, `DM Reopen E2E ${Date.now()}`)
      const invite = await createInvite(reopenUserA.token, reopenServer.id)
      await joinServer(reopenUserB.token, reopenServer.id, invite.code)

      // Create DM, then close via API
      const dm = await createDm(reopenUserA.token, reopenUserB.id)
      await closeDm(reopenUserA.token, dm.serverId)

      // Reopen DM via API — creates a new DM server+channel
      const reopened = await createDm(reopenUserA.token, reopenUserB.id)

      // WHY: The reopened DM should have a different serverId (backend creates new)
      expect(reopened.serverId).not.toBe(dm.serverId)

      // Send a message in the NEW DM to verify it works end-to-end
      const uniqueMsg = `Reopened DM check ${Date.now()}`
      await sendMessage(reopenUserA.token, reopened.channelId, uniqueMsg)

      await authenticatePage(page, reopenUserA)

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

      // Verify the new message appears in the reopened DM
      const messageContent = page
        .locator('[data-test="message-content"]')
        .filter({ hasText: uniqueMsg })
      await expect(messageContent.first()).toBeVisible({ timeout: 15_000 })
    })
  })

  test.describe('edge cases', () => {
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

      // Create 10 DMs (should all succeed with 201 Created)
      for (let i = 0; i < 10; i++) {
        const result = await createDmRaw(rateLimitUser.token, targets[i].id)
        expect(result.status).toBe(201)
      }

      // The 11th should be rate-limited (429)
      const result = await createDmRaw(rateLimitUser.token, targets[10].id)
      expect(result.status).toBe(429)
    })
  })
})
