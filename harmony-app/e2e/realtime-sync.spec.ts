/**
 * E2E Tests — Multi-User Realtime Synchronization
 *
 * Expands on concurrent.spec.ts to cover additional realtime scenarios:
 * - Message delivery between two users (single page + API, and dual page)
 * - Channel creation visibility for other members
 * - Role change visibility for other members
 *
 * WHY scope limitations:
 * - Typing indicator uses Supabase Broadcast (not Postgres Changes). In local dev,
 *   Broadcast delivery is variable and would make tests flaky. The typing indicator
 *   is covered by unit tests (use-typing-indicator.test.ts).
 * - The app currently subscribes to Realtime postgres_changes on the `messages` table
 *   only (use-realtime-messages.ts). Server/channel/member changes do NOT propagate
 *   via Realtime — they require query invalidation (page refresh or navigation).
 *   Tests for those scenarios use the deterministic reload pattern from concurrent.spec.ts.
 *
 * Real data-test attributes from:
 * - chat-area.tsx:468 (chat-area), :475 (message-list), :286 (message-input)
 * - message-item.tsx:91 (message-item), :169 (message-content), :260 (message-author)
 * - channel-sidebar.tsx (channel-list, channel-button)
 * - member-list.tsx:129 (member-list), :242 (member-item), :261 (member-username)
 * - role-badge.tsx:24,33,42 (member-role-badge with data-role attr)
 * - server-list.tsx:117 (dm-home-button), server-button
 * - main-layout.tsx:198 (main-layout)
 */
import { expect, test } from '@playwright/test'
import { authenticatePage, selectChannel, selectServer } from './fixtures/auth-fixture'
import {
  assignRole,
  createChannel,
  createInvite,
  createServer,
  getServerChannels,
  joinServer,
  sendMessage,
  syncProfile,
} from './fixtures/test-data-factory'
import { createTestUser, type TestUser } from './fixtures/user-factory'

test.describe('Multi-User Realtime Sync', () => {
  // ── Message Delivery Between Two Users ───────────────────────────

  test.describe('message delivery', () => {
    let userA: TestUser
    let userB: TestUser
    let server: { id: string; name: string }
    let channelId: string
    let channelName: string

    test.beforeAll(async () => {
      userA = await createTestUser('rt-msg-a')
      userB = await createTestUser('rt-msg-b')
      for (const u of [userA, userB]) await syncProfile(u.token)

      server = await createServer(userA.token, `RTMsg E2E ${Date.now()}`)
      const invite = await createInvite(userA.token, server.id)
      await joinServer(userB.token, server.id, invite.code)

      const { items: channels } = await getServerChannels(userA.token, server.id)
      channelId = channels[0].id
      channelName = channels[0].name
    })

    test('User B sees message sent by User A via API', async ({ page }) => {
      // WHY: User B opens the channel, then User A sends a message via API.
      // After a deterministic reload, User B should see the message.
      // This pattern is from concurrent.spec.ts — avoids flaky Realtime dependency.
      await authenticatePage(page, userB)
      await selectServer(page, server.id)
      await selectChannel(page, channelName)

      // WHY: Wait for the chat area to be fully mounted and the initial query to resolve.
      await page
        .locator('[data-test="empty-state"], [data-test="message-item"]')
        .first()
        .waitFor({ timeout: 15_000 })

      // User A sends a message via API
      const uniqueMessage = `rt-delivery-test-${Date.now()}`
      await sendMessage(userA.token, channelId, uniqueMessage)

      // WHY: Deterministic reload — navigates away and back to trigger a fresh
      // useMessages query. Avoids depending on Supabase Realtime local delivery.
      await page.goto('/')
      await page.locator('[data-test="main-layout"]').waitFor({ timeout: 15_000 })
      await selectServer(page, server.id)
      await selectChannel(page, channelName)

      const messageLocator = page
        .locator('[data-test="message-content"]')
        .filter({ hasText: uniqueMessage })
      await expect(messageLocator).toBeVisible({ timeout: 10_000 })
    })

    test('User B sees message sent by User A in two browser contexts', async ({
      page,
      browser,
    }) => {
      const uniqueMessage = `rt-dual-ctx-${Date.now()}`

      // --- User A sends a message via their browser context ---
      await authenticatePage(page, userA)
      await selectServer(page, server.id)
      await selectChannel(page, channelName)

      const messageInput = page.locator('[data-test="message-input"]')
      await messageInput.fill(uniqueMessage)
      await expect(messageInput).toHaveValue(uniqueMessage)

      const responsePromise = page.waitForResponse(
        (response) =>
          response.url().includes(`/v1/channels/${channelId}/messages`) &&
          response.request().method() === 'POST',
      )

      await messageInput.press('Enter')

      const response = await responsePromise
      expect(response.status()).toBe(201)

      // Verify User A sees their own message
      const sentMessage = page
        .locator('[data-test="message-content"]')
        .filter({ hasText: uniqueMessage })
      await expect(sentMessage.first()).toBeVisible({ timeout: 10_000 })

      // --- User B opens a separate browser context ---
      // WHY: browser.newContext() does NOT inherit `use.baseURL` from playwright.config.ts.
      const contextB = await browser.newContext({ baseURL: 'http://localhost:1420' })
      const pageB = await contextB.newPage()

      await authenticatePage(pageB, userB)
      await selectServer(pageB, server.id)
      await selectChannel(pageB, channelName)

      // Verify User B sees User A's message
      const messageLocatorB = pageB
        .locator('[data-test="message-content"]')
        .filter({ hasText: uniqueMessage })
      await expect(messageLocatorB).toBeVisible({ timeout: 10_000 })

      await contextB.close()
    })

    test('multiple messages appear in correct order', async ({ page }) => {
      // WHY: Verify that when multiple messages are sent sequentially, they appear
      // in the correct chronological order in the chat area.
      const msg1 = `rt-order-first-${Date.now()}`
      const msg2 = `rt-order-second-${Date.now()}`
      const msg3 = `rt-order-third-${Date.now()}`

      await sendMessage(userA.token, channelId, msg1)
      await sendMessage(userB.token, channelId, msg2)
      await sendMessage(userA.token, channelId, msg3)

      await authenticatePage(page, userB)
      await selectServer(page, server.id)
      await selectChannel(page, channelName)

      // All three messages should be visible
      for (const msg of [msg1, msg2, msg3]) {
        const loc = page.locator('[data-test="message-content"]').filter({ hasText: msg })
        await expect(loc).toBeVisible({ timeout: 10_000 })
      }

      // WHY: Verify order by checking the DOM sequence — msg1 should appear before
      // msg2, and msg2 before msg3. We use the message-list container and find the
      // index of each message within the rendered items.
      const allContents = page.locator('[data-test="message-content"]')
      const allTexts = await allContents.allTextContents()

      const idx1 = allTexts.findIndex((t) => t.includes(msg1))
      const idx2 = allTexts.findIndex((t) => t.includes(msg2))
      const idx3 = allTexts.findIndex((t) => t.includes(msg3))

      // All messages should be found
      expect(idx1).toBeGreaterThanOrEqual(0)
      expect(idx2).toBeGreaterThanOrEqual(0)
      expect(idx3).toBeGreaterThanOrEqual(0)

      // Chronological order: msg1 < msg2 < msg3
      expect(idx1).toBeLessThan(idx2)
      expect(idx2).toBeLessThan(idx3)
    })
  })

  // ── Channel Creation Visibility ─────────────────────────────────

  test.describe('channel creation visibility', () => {
    let channelOwner: TestUser
    let channelMember: TestUser
    let channelServer: { id: string; name: string }

    test.beforeAll(async () => {
      channelOwner = await createTestUser('rt-ch-owner')
      channelMember = await createTestUser('rt-ch-member')
      for (const u of [channelOwner, channelMember]) await syncProfile(u.token)

      channelServer = await createServer(channelOwner.token, `RTCh E2E ${Date.now()}`)
      const invite = await createInvite(channelOwner.token, channelServer.id)
      await joinServer(channelMember.token, channelServer.id, invite.code)
    })

    test('new channel created by owner is visible to member after reload', async ({ page }) => {
      // WHY: Channel creation does NOT use Realtime (no postgres_changes subscription
      // on the channels table). The member sees the new channel only after navigating
      // away and back, triggering a useChannels() refetch.
      const newChannelName = `rt-visible-${Date.now()}`
      await createChannel(channelOwner.token, channelServer.id, newChannelName)

      // Member loads the server — the new channel should be in the channel list.
      await authenticatePage(page, channelMember)
      await selectServer(page, channelServer.id)

      const channelButton = page
        .locator('[data-test="channel-button"]')
        .filter({ hasText: newChannelName })
      await expect(channelButton).toBeVisible({ timeout: 15_000 })
    })

    test('member can open and use the newly created channel', async ({ page }) => {
      // WHY: Beyond visibility, verify the channel is fully functional — member
      // can navigate to it and see the chat area.
      const usableChannelName = `rt-usable-${Date.now()}`
      const newChannel = await createChannel(
        channelOwner.token,
        channelServer.id,
        usableChannelName,
      )

      await authenticatePage(page, channelMember)
      await selectServer(page, channelServer.id)
      await selectChannel(page, usableChannelName)

      // Chat area should load (empty state for a new channel)
      const chatArea = page.locator('[data-test="chat-area"]')
      await expect(chatArea).toBeVisible({ timeout: 10_000 })

      // Send a message to confirm the channel is functional
      const messageInput = page.locator('[data-test="message-input"]')
      await messageInput.fill('First message in new channel')
      await expect(messageInput).toHaveValue('First message in new channel')

      const responsePromise = page.waitForResponse(
        (response) =>
          response.url().includes(`/v1/channels/${newChannel.id}/messages`) &&
          response.request().method() === 'POST',
      )

      await messageInput.press('Enter')

      const msgResponse = await responsePromise
      expect(msgResponse.status()).toBe(201)

      const sentMessage = page
        .locator('[data-test="message-content"]')
        .filter({ hasText: 'First message in new channel' })
      await expect(sentMessage.first()).toBeVisible({ timeout: 10_000 })
    })
  })

  // ── Role Change Visibility ──────────────────────────────────────

  test.describe('role change visibility', () => {
    let roleOwner: TestUser
    let roleTarget: TestUser
    let roleServer: { id: string; name: string }

    test.beforeAll(async () => {
      roleOwner = await createTestUser('rt-role-owner')
      roleTarget = await createTestUser('rt-role-target')
      for (const u of [roleOwner, roleTarget]) await syncProfile(u.token)

      roleServer = await createServer(roleOwner.token, `RTRole E2E ${Date.now()}`)
      const invite = await createInvite(roleOwner.token, roleServer.id)
      await joinServer(roleTarget.token, roleServer.id, invite.code)
    })

    test('role change from member to moderator is visible after page load', async ({ page }) => {
      // WHY: Role changes do NOT propagate via Realtime. The member list is refetched
      // on server selection (useMembers query). We assign the role via API, then
      // load the page to verify the role badge updates correctly.
      await assignRole(roleOwner.token, roleServer.id, roleTarget.id, 'moderator')

      await authenticatePage(page, roleOwner)
      await selectServer(page, roleServer.id)

      const memberList = page.locator('[data-test="member-list"]')
      await memberList.waitFor({ timeout: 10_000 })

      const targetItem = memberList.locator(
        `[data-test="member-item"][data-user-id="${roleTarget.id}"]`,
      )
      await expect(targetItem).toBeVisible({ timeout: 10_000 })

      // WHY: role-badge.tsx renders data-test="member-role-badge" with data-role attr.
      // After promotion to moderator, the badge should show "moderator".
      await expect(
        targetItem.locator('[data-test="member-role-badge"][data-role="moderator"]'),
      ).toBeVisible({ timeout: 10_000 })
    })

    test('promoted user sees their own new role badge', async ({ page }) => {
      // WHY: The promoted user should see their own updated role badge in the member list.
      // This catches regressions where the current user's role is cached differently
      // from other members' roles.
      await assignRole(roleOwner.token, roleServer.id, roleTarget.id, 'admin')

      await authenticatePage(page, roleTarget)
      await selectServer(page, roleServer.id)

      const memberList = page.locator('[data-test="member-list"]')
      await memberList.waitFor({ timeout: 10_000 })

      const selfItem = memberList.locator(
        `[data-test="member-item"][data-user-id="${roleTarget.id}"]`,
      )
      await expect(selfItem).toBeVisible({ timeout: 10_000 })

      await expect(
        selfItem.locator('[data-test="member-role-badge"][data-role="admin"]'),
      ).toBeVisible({ timeout: 10_000 })
    })

    test('demoted user sees updated role badge', async ({ page }) => {
      // WHY: After demotion from admin back to member, the role badge should disappear
      // (role-badge.tsx returns null for 'member' role).
      await assignRole(roleOwner.token, roleServer.id, roleTarget.id, 'member')

      await authenticatePage(page, roleTarget)
      await selectServer(page, roleServer.id)

      const memberList = page.locator('[data-test="member-list"]')
      await memberList.waitFor({ timeout: 10_000 })

      const selfItem = memberList.locator(
        `[data-test="member-item"][data-user-id="${roleTarget.id}"]`,
      )
      await expect(selfItem).toBeVisible({ timeout: 10_000 })

      // WHY: role-badge.tsx returns null for 'member' role — no badge rendered.
      await expect(selfItem.locator('[data-test="member-role-badge"]')).not.toBeAttached()
    })
  })

  // ── Cross-User Message Author Attribution ───────────────────────

  test.describe('message author attribution', () => {
    let authorA: TestUser
    let authorB: TestUser
    let authorServer: { id: string; name: string }
    let authorChannelId: string

    test.beforeAll(async () => {
      authorA = await createTestUser('rt-auth-a')
      authorB = await createTestUser('rt-auth-b')
      for (const u of [authorA, authorB]) await syncProfile(u.token)

      authorServer = await createServer(authorA.token, `RTAuthor E2E ${Date.now()}`)
      const invite = await createInvite(authorA.token, authorServer.id)
      await joinServer(authorB.token, authorServer.id, invite.code)

      const { items: channels } = await getServerChannels(authorA.token, authorServer.id)
      authorChannelId = channels[0].id
    })

    test('messages from different users show distinct author labels', async ({ page }) => {
      // WHY: When two users send messages, each message should show the sender's
      // author label. This verifies the message-item.tsx authorLabel is populated
      // correctly from the API response.
      const msgA = await sendMessage(authorA.token, authorChannelId, `From A ${Date.now()}`)
      const msgB = await sendMessage(authorB.token, authorChannelId, `From B ${Date.now()}`)

      await authenticatePage(page, authorA)
      await selectServer(page, authorServer.id)
      await selectChannel(page, 'general')

      // Find both messages
      const itemA = page.locator(`[data-test="message-item"][data-message-id="${msgA.id}"]`)
      const itemB = page.locator(`[data-test="message-item"][data-message-id="${msgB.id}"]`)
      await expect(itemA).toBeVisible({ timeout: 10_000 })
      await expect(itemB).toBeVisible({ timeout: 10_000 })

      // Verify each has a non-empty author label
      const authorLabelA = itemA.locator('[data-test="message-author"]')
      const authorLabelB = itemB.locator('[data-test="message-author"]')
      await expect(authorLabelA).toContainText(/.+/)
      await expect(authorLabelB).toContainText(/.+/)

      // WHY: The two messages should have different author labels (different users).
      const textA = await authorLabelA.textContent()
      const textB = await authorLabelB.textContent()
      expect(textA).not.toBe(textB)
    })
  })
})
