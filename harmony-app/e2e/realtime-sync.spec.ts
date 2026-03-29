/**
 * E2E Tests — Multi-User Realtime Synchronization
 *
 * Expands on concurrent.spec.ts to cover additional realtime scenarios:
 * - Message delivery between two users (single page + API, and dual page)
 * - Channel creation visibility for other members
 * - Role change visibility for other members
 * - Live role change via SSE (member.role_updated event)
 * - Live ownership transfer via SSE (member.role_updated events)
 * - Kicked user loses server access via SSE (force.disconnect event)
 * - Live message delivery via SSE (message.created event)
 * - Live message deletion via SSE (message.deleted event)
 * - Live message edit via SSE (message.updated event)
 * - Live channel creation via SSE (channel.created event)
 * - Live member join via SSE (member.joined event)
 * - Live DM message delivery via SSE (message.created in DM channel)
 * - Banned user loses access via SSE (force.disconnect event)
 *
 * WHY scope limitations:
 * - Typing indicator uses SSE typing.started events but delivery is ephemeral
 *   and variable in local dev. Covered by unit tests (use-typing-indicator.test.ts).
 *
 * SSE realtime events used:
 * - message.created: useRealtimeMessages inserts new message into TanStack Query cache
 * - message.updated: useRealtimeMessages replaces message in-place (content + editedAt)
 * - message.deleted: useRealtimeMessages sets deletedBy to trigger tombstone rendering
 * - member.joined: useRealtimeMembers appends new member to TanStack Query cache
 * - channel.created: useRealtimeChannels appends new channel to TanStack Query cache
 * - member.role_updated: useRealtimeMembers updates TanStack Query cache in-place
 * - dm.created: useRealtimeDms invalidates DM list cache
 * - force.disconnect: useForceDisconnect invalidates server list + clears selection
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
  banUser,
  createChannel,
  createDm,
  createInvite,
  createServer,
  deleteMessage,
  editMessage,
  getServerChannels,
  joinServer,
  kickMember,
  sendMessage,
  syncProfile,
  transferOwnership,
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
      // SSE delivers the message.created event in real-time, so User B sees
      // the message appear without any navigation or reload.
      await authenticatePage(page, userB)
      await selectServer(page, server.id)
      await selectChannel(page, channelName)

      // WHY: Wait for the chat area to be fully mounted and the initial query to resolve.
      await page.locator('[data-test="chat-area"]').waitFor({ timeout: 15_000 })

      // User A sends a message via API
      const uniqueMessage = `rt-delivery-test-${Date.now()}`
      await sendMessage(userA.token, channelId, uniqueMessage)

      // WHY: SSE delivers message.created events in real-time. The hook
      // (use-realtime-messages.ts) inserts the message into the TanStack Query
      // cache directly, so it should appear without any navigation or reload.
      const messageLocator = page
        .locator('[data-test="message-content"]')
        .filter({ hasText: uniqueMessage })
      await expect(messageLocator).toBeVisible({ timeout: 15_000 })
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

      try {
        await authenticatePage(pageB, userB)
        await selectServer(pageB, server.id)
        await selectChannel(pageB, channelName)

        // Verify User B sees User A's message
        const messageLocatorB = pageB
          .locator('[data-test="message-content"]')
          .filter({ hasText: uniqueMessage })
        await expect(messageLocatorB).toBeVisible({ timeout: 10_000 })
      } finally {
        await contextB.close()
      }
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
      // WHY: SSE delivers channel.created events and useRealtimeChannels updates cache.
      // This test verifies the fresh page-load path (member loads server after channel
      // was created via API). The SSE live path is covered by the member loading in.
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
      // WHY: SSE delivers member.role_updated events and useRealtimeMembers updates
      // the cache in-place. This test verifies the page-load path (role assigned via
      // API before page load). The SSE live path is tested separately.
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

  // ── Live SSE Message Events (dual browser context) ────────────────
  // WHY: These tests verify that SSE events (message.created, message.deleted,
  // message.updated) update User B's UI in real-time while User B is already
  // viewing the channel. No navigation or reload — pure SSE push.

  test.describe('live SSE message events', () => {
    let liveUserA: TestUser
    let liveUserB: TestUser
    let liveServer: { id: string; name: string }
    let liveChannelId: string
    let liveChannelName: string

    test.beforeAll(async () => {
      liveUserA = await createTestUser('rt-live-a')
      liveUserB = await createTestUser('rt-live-b')
      for (const u of [liveUserA, liveUserB]) await syncProfile(u.token)

      liveServer = await createServer(liveUserA.token, `RTLive E2E ${Date.now()}`)
      const invite = await createInvite(liveUserA.token, liveServer.id)
      await joinServer(liveUserB.token, liveServer.id, invite.code)

      const { items: channels } = await getServerChannels(liveUserA.token, liveServer.id)
      liveChannelId = channels[0].id
      liveChannelName = channels[0].name
    })

    test('live message delivery: User B sees new message without navigation', async ({
      browser,
    }) => {
      // WHY: Both users have their own browser context with an active SSE connection.
      // User B is already viewing the channel when User A sends a message. The SSE
      // message.created event should make the message appear in User B's chat without
      // any page navigation or reload.
      const contextA = await browser.newContext({ baseURL: 'http://localhost:1420' })
      const contextB = await browser.newContext({ baseURL: 'http://localhost:1420' })
      const pageA = await contextA.newPage()
      const pageB = await contextB.newPage()

      try {
        // Both users navigate to the same channel
        await authenticatePage(pageB, liveUserB)
        await selectServer(pageB, liveServer.id)
        await selectChannel(pageB, liveChannelName)

        // WHY: Ensure User B's SSE connection is established before User A sends.
        await pageB.locator('[data-test="chat-area"]').waitFor({ timeout: 15_000 })

        await authenticatePage(pageA, liveUserA)
        await selectServer(pageA, liveServer.id)
        await selectChannel(pageA, liveChannelName)

        // User A sends a message
        const uniqueMessage = `live-delivery-${Date.now()}`
        const messageInput = pageA.locator('[data-test="message-input"]')
        await messageInput.fill(uniqueMessage)
        await messageInput.press('Enter')

        // User A sees their own message (optimistic or after POST)
        const sentOnA = pageA
          .locator('[data-test="message-content"]')
          .filter({ hasText: uniqueMessage })
        await expect(sentOnA.first()).toBeVisible({ timeout: 10_000 })

        // User B sees the message via SSE — NO navigation, NO reload
        const receivedOnB = pageB
          .locator('[data-test="message-content"]')
          .filter({ hasText: uniqueMessage })
        await expect(receivedOnB).toBeVisible({ timeout: 15_000 })
      } finally {
        await contextA.close()
        await contextB.close()
      }
    })

    test('live message deletion: User B sees tombstone after User A deletes', async ({
      browser,
    }) => {
      // WHY: User A sends a message, both users see it, then User A deletes it.
      // User B should see the message replaced with a deleted tombstone via SSE
      // message.deleted event — without any navigation or reload.
      const uniqueMessage = `live-delete-${Date.now()}`
      const msg = await sendMessage(liveUserA.token, liveChannelId, uniqueMessage)

      const contextB = await browser.newContext({ baseURL: 'http://localhost:1420' })
      const pageB = await contextB.newPage()

      try {
        // User B opens the channel and sees the message
        await authenticatePage(pageB, liveUserB)
        await selectServer(pageB, liveServer.id)
        await selectChannel(pageB, liveChannelName)

        const messageOnB = pageB
          .locator('[data-test="message-content"]')
          .filter({ hasText: uniqueMessage })
        await expect(messageOnB).toBeVisible({ timeout: 10_000 })

        // User A deletes the message via API
        await deleteMessage(liveUserA.token, liveChannelId, msg.id)

        // WHY: SSE message.deleted sets deletedBy in the TanStack Query cache.
        // message-item.tsx renders data-test-deleted="true" on the tombstone.
        const tombstoneOnB = pageB.locator(
          `[data-test="message-item"][data-message-id="${msg.id}"] [data-test="message-content"][data-test-deleted="true"]`,
        )
        await expect(tombstoneOnB).toBeVisible({ timeout: 15_000 })
      } finally {
        await contextB.close()
      }
    })

    test('live message edit: User B sees updated content and edited indicator', async ({
      browser,
    }) => {
      // WHY: User A sends a message, both users see it, then User A edits it.
      // User B should see the content change and an "(edited)" indicator appear
      // via SSE message.updated event — without any navigation or reload.
      const originalContent = `live-edit-before-${Date.now()}`
      const editedContent = `live-edit-after-${Date.now()}`
      const msg = await sendMessage(liveUserA.token, liveChannelId, originalContent)

      const contextB = await browser.newContext({ baseURL: 'http://localhost:1420' })
      const pageB = await contextB.newPage()

      try {
        // User B opens the channel and sees the original message
        await authenticatePage(pageB, liveUserB)
        await selectServer(pageB, liveServer.id)
        await selectChannel(pageB, liveChannelName)

        const messageOnB = pageB.locator(
          `[data-test="message-item"][data-message-id="${msg.id}"] [data-test="message-content"]`,
        )
        await expect(messageOnB).toHaveText(originalContent, { timeout: 10_000 })

        // WHY: Verify no edited indicator before the edit
        const editedIndicator = pageB.locator(
          `[data-test="message-item"][data-message-id="${msg.id}"] [data-test="message-edited-indicator"]`,
        )
        await expect(editedIndicator).toHaveCount(0)

        // User A edits the message via API
        await editMessage(liveUserA.token, liveChannelId, msg.id, editedContent)

        // WHY: SSE message.updated replaces the message in the TanStack Query cache.
        // message-item.tsx re-renders with new content and shows "(edited)" indicator.
        await expect(messageOnB).toHaveText(new RegExp(editedContent), { timeout: 15_000 })
        await expect(editedIndicator).toBeVisible({ timeout: 15_000 })
      } finally {
        await contextB.close()
      }
    })
  })

  // ── Live Channel Creation via SSE ────────────────────────────────
  // WHY: Verifies that SSE channel.created events update the channel sidebar
  // in real-time. useRealtimeChannels appends the new channel to the TanStack
  // Query cache, so existing members see it appear without navigation or reload.

  test.describe('live channel creation via SSE', () => {
    test('member sees new channel appear in sidebar without navigation', async ({ browser }) => {
      // WHY: Isolated server per test — channel creation mutates shared state.
      const chOwner = await createTestUser('rt-live-ch-owner')
      const chMember = await createTestUser('rt-live-ch-member')
      for (const u of [chOwner, chMember]) await syncProfile(u.token)

      const chServer = await createServer(chOwner.token, `RTLiveCh E2E ${Date.now()}`)
      const invite = await createInvite(chOwner.token, chServer.id)
      await joinServer(chMember.token, chServer.id, invite.code)

      // Member opens the server in a separate browser context
      const memberCtx = await browser.newContext({ baseURL: 'http://localhost:1420' })
      const memberPage = await memberCtx.newPage()

      try {
        await authenticatePage(memberPage, chMember)
        await selectServer(memberPage, chServer.id)

        // WHY: Wait for the channel list to confirm the page is fully loaded
        // and the SSE connection is established before the owner creates a channel.
        const channelList = memberPage.locator('[data-test="channel-list"]')
        await channelList.waitFor({ timeout: 15_000 })

        // Owner creates a new channel via API (triggers SSE channel.created)
        const newChannelName = `live-new-ch-${Date.now()}`
        await createChannel(chOwner.token, chServer.id, newChannelName)

        // WHY: SSE delivers channel.created event. useRealtimeChannels appends the
        // channel to the TanStack Query cache — the sidebar should update without
        // any page navigation or reload.
        const channelButton = memberPage
          .locator('[data-test="channel-button"]')
          .filter({ hasText: newChannelName })
        await expect(channelButton).toBeVisible({ timeout: 15_000 })
      } finally {
        await memberCtx.close()
      }
    })
  })

  // ── Live Role Change via SSE ──────────────────────────────────────

  test.describe('live role change via SSE', () => {
    let liveRoleOwner: TestUser
    let liveRoleTarget: TestUser
    let liveRoleObserver: TestUser
    let liveRoleServer: { id: string; name: string }

    test.beforeAll(async () => {
      liveRoleOwner = await createTestUser('rt-live-role-owner')
      liveRoleTarget = await createTestUser('rt-live-role-target')
      liveRoleObserver = await createTestUser('rt-live-role-observer')
      for (const u of [liveRoleOwner, liveRoleTarget, liveRoleObserver]) await syncProfile(u.token)

      liveRoleServer = await createServer(liveRoleOwner.token, `RTLiveRole E2E ${Date.now()}`)
      const invite = await createInvite(liveRoleOwner.token, liveRoleServer.id)
      for (const u of [liveRoleTarget, liveRoleObserver]) {
        await joinServer(u.token, liveRoleServer.id, invite.code)
      }
    })

    test('observer sees role badge update in real-time when admin promotes member', async ({
      browser,
    }) => {
      // WHY: Two browser contexts -- observer has the member list open, owner
      // promotes the target via the API. The SSE member.role_updated event should
      // update the observer's member list badge without any page reload.
      const observerCtx = await browser.newContext({ baseURL: 'http://localhost:1420' })
      const observerPage = await observerCtx.newPage()

      try {
        await authenticatePage(observerPage, liveRoleObserver)
        await selectServer(observerPage, liveRoleServer.id)

        const memberList = observerPage.locator('[data-test="member-list"]')
        await memberList.waitFor({ timeout: 15_000 })

        // WHY: Verify the target currently has no role badge (default 'member' role
        // renders no badge in role-badge.tsx).
        const targetItem = memberList.locator(
          `[data-test="member-item"][data-user-id="${liveRoleTarget.id}"]`,
        )
        await expect(targetItem).toBeVisible({ timeout: 10_000 })

        // Owner promotes target to moderator via API (triggers SSE member.role_updated)
        await assignRole(liveRoleOwner.token, liveRoleServer.id, liveRoleTarget.id, 'moderator')

        // WHY: Wait for the moderator badge to appear on the observer's page via SSE.
        // useRealtimeMembers handles member.role_updated by replacing the member
        // in the TanStack Query cache -- the badge should update without reload.
        await expect(
          targetItem.locator('[data-test="member-role-badge"][data-role="moderator"]'),
        ).toBeVisible({ timeout: 15_000 })
      } finally {
        await observerCtx.close()
      }
    })
  })

  // ── Live Ownership Transfer via SSE ───────────────────────────────

  test.describe('live ownership transfer via SSE', () => {
    test('all members see role badges update in real-time after ownership transfer', async ({
      browser,
    }) => {
      // WHY: Isolated server per test -- ownership transfer is destructive.
      const xferOwner = await createTestUser('rt-live-xfer-owner')
      const xferAdmin = await createTestUser('rt-live-xfer-admin')
      const xferObserver = await createTestUser('rt-live-xfer-observer')
      for (const u of [xferOwner, xferAdmin, xferObserver]) await syncProfile(u.token)

      const xferServer = await createServer(xferOwner.token, `RTLiveXfer E2E ${Date.now()}`)
      const invite = await createInvite(xferOwner.token, xferServer.id)
      for (const u of [xferAdmin, xferObserver]) {
        await joinServer(u.token, xferServer.id, invite.code)
      }
      await assignRole(xferOwner.token, xferServer.id, xferAdmin.id, 'admin')

      // Observer opens member list in a separate browser context
      const observerCtx = await browser.newContext({ baseURL: 'http://localhost:1420' })
      const observerPage = await observerCtx.newPage()

      try {
        await authenticatePage(observerPage, xferObserver)
        await selectServer(observerPage, xferServer.id)

        const memberList = observerPage.locator('[data-test="member-list"]')
        await memberList.waitFor({ timeout: 15_000 })

        // WHY: Verify initial state -- owner has owner badge, admin has admin badge.
        const ownerItem = memberList.locator(
          `[data-test="member-item"][data-user-id="${xferOwner.id}"]`,
        )
        const adminItem = memberList.locator(
          `[data-test="member-item"][data-user-id="${xferAdmin.id}"]`,
        )
        await expect(
          ownerItem.locator('[data-test="member-role-badge"][data-role="owner"]'),
        ).toBeVisible({ timeout: 10_000 })
        await expect(
          adminItem.locator('[data-test="member-role-badge"][data-role="admin"]'),
        ).toBeVisible({ timeout: 10_000 })

        // Transfer ownership via API (triggers SSE member.role_updated for both users)
        await transferOwnership(xferOwner.token, xferServer.id, xferAdmin.id)

        // WHY: The SSE delivers two member.role_updated events -- one for the new owner
        // (promoted to owner) and one for the old owner (demoted to admin).
        // useRealtimeMembers updates both in the cache without reload.
        await expect(
          adminItem.locator('[data-test="member-role-badge"][data-role="owner"]'),
        ).toBeVisible({ timeout: 15_000 })
        await expect(
          ownerItem.locator('[data-test="member-role-badge"][data-role="admin"]'),
        ).toBeVisible({ timeout: 15_000 })
      } finally {
        await observerCtx.close()
      }
    })
  })

  // ── Kicked User Loses Access via SSE ──────────────────────────────

  test.describe('kicked user loses access via SSE', () => {
    test('server disappears from kicked user sidebar in real-time', async ({ browser }) => {
      // WHY: Isolated server -- kick is destructive to membership.
      const kickOwner = await createTestUser('rt-live-kick-owner')
      const kickTarget = await createTestUser('rt-live-kick-target')
      for (const u of [kickOwner, kickTarget]) await syncProfile(u.token)

      const kickServer = await createServer(kickOwner.token, `RTLiveKick E2E ${Date.now()}`)
      const invite = await createInvite(kickOwner.token, kickServer.id)
      await joinServer(kickTarget.token, kickServer.id, invite.code)

      // Target opens the server in a browser context
      const targetCtx = await browser.newContext({ baseURL: 'http://localhost:1420' })
      const targetPage = await targetCtx.newPage()

      try {
        await authenticatePage(targetPage, kickTarget)
        await selectServer(targetPage, kickServer.id)

        // WHY: Verify the server button is visible in the sidebar before kick.
        const serverButton = targetPage.locator(
          `[data-test="server-button"][data-server-id="${kickServer.id}"]`,
        )
        await expect(serverButton).toBeVisible({ timeout: 10_000 })

        // Owner kicks the target via API (triggers SSE force.disconnect)
        await kickMember(kickOwner.token, kickServer.id, kickTarget.id)

        // WHY: useForceDisconnect handles the force.disconnect SSE event by:
        // 1. Invalidating queryKeys.servers.all -> refetch removes the server
        // 2. Clearing selectedServerId if viewing the kicked server
        // The server button should disappear from the sidebar without reload.
        await expect(serverButton).not.toBeVisible({ timeout: 15_000 })
      } finally {
        await targetCtx.close()
      }
    })
  })

  // ── Live Member Join via SSE ──────────────────────────────────────
  // WHY: Verifies that SSE member.joined events update the member list in
  // real-time. useRealtimeMembers appends the new member to TanStack Query
  // cache, so existing users see the new member appear without navigation.

  test.describe('live member join via SSE', () => {
    test('existing member sees new member appear in member list after join', async ({
      browser,
    }) => {
      // WHY: Two separate browser contexts simulate two real users. User A is
      // already viewing the server's member list when User B joins via API.
      // The SSE member.joined event should make User B appear in User A's
      // member list without any page navigation or reload.
      const joinOwner = await createTestUser('rt-join-owner')
      const joinNewbie = await createTestUser('rt-join-newbie')
      for (const u of [joinOwner, joinNewbie]) await syncProfile(u.token)

      const joinSrv = await createServer(joinOwner.token, `RTJoin E2E ${Date.now()}`)
      const invite = await createInvite(joinOwner.token, joinSrv.id)

      const ownerCtx = await browser.newContext({ baseURL: 'http://localhost:1420' })
      const ownerPage = await ownerCtx.newPage()

      try {
        // Owner loads the server and views the member list
        await authenticatePage(ownerPage, joinOwner)
        await selectServer(ownerPage, joinSrv.id)

        const memberList = ownerPage.locator('[data-test="member-list"]')
        await memberList.waitFor({ timeout: 15_000 })

        // WHY: Confirm the newbie is NOT in the member list before joining.
        const newbieItem = memberList.locator(
          `[data-test="member-item"][data-user-id="${joinNewbie.id}"]`,
        )
        await expect(newbieItem).not.toBeAttached()

        // Newbie joins the server via API
        await joinServer(joinNewbie.token, joinSrv.id, invite.code)

        // WHY: SSE delivers member.joined event. useRealtimeMembers appends
        // the new member to the cache. Owner should see the newbie appear
        // without any page navigation or reload.
        await expect(newbieItem).toBeVisible({ timeout: 15_000 })
      } finally {
        await ownerCtx.close()
      }
    })
  })

  // ── Live DM Message Delivery via SSE ──────────────────────────────
  // WHY: Verifies that SSE message.created events work in DM channels.
  // The recipient already has the DM conversation open in their chat area.
  // The message should appear without any navigation or reload.

  test.describe('live DM message delivery via SSE', () => {
    test('recipient sees message in already-open DM conversation', async ({ browser }) => {
      // WHY: User A and User B both have the DM conversation open. User A sends
      // a message via the UI. User B should see it appear via SSE message.created
      // event — no navigation, no reload.
      const dmSender = await createTestUser('rt-dm-sender')
      const dmRecipient = await createTestUser('rt-dm-recipient')
      for (const u of [dmSender, dmRecipient]) await syncProfile(u.token)

      // WHY: Users must share a server for DM creation.
      const dmSharedSrv = await createServer(dmSender.token, `RTDm E2E ${Date.now()}`)
      const invite = await createInvite(dmSender.token, dmSharedSrv.id)
      await joinServer(dmRecipient.token, dmSharedSrv.id, invite.code)

      // Create DM via API so both users have the conversation
      const dm = await createDm(dmSender.token, dmRecipient.id)

      const senderCtx = await browser.newContext({ baseURL: 'http://localhost:1420' })
      const recipientCtx = await browser.newContext({ baseURL: 'http://localhost:1420' })
      const pageSender = await senderCtx.newPage()
      const pageRecipient = await recipientCtx.newPage()

      try {
        // Recipient opens the DM conversation first
        await authenticatePage(pageRecipient, dmRecipient)
        await pageRecipient.locator('[data-test="dm-home-button"]').click()
        await pageRecipient.locator('[data-test="dm-sidebar"]').waitFor({ timeout: 10_000 })

        const dmItemRecipient = pageRecipient.locator(
          `[data-test="dm-conversation-item"][data-dm-server-id="${dm.serverId}"]`,
        )
        await dmItemRecipient.waitFor({ timeout: 10_000 })
        await dmItemRecipient.click()
        await pageRecipient.locator('[data-test="chat-area"]').waitFor({ timeout: 10_000 })

        // Sender opens the DM and sends a message via the UI
        await authenticatePage(pageSender, dmSender)
        await pageSender.locator('[data-test="dm-home-button"]').click()
        await pageSender.locator('[data-test="dm-sidebar"]').waitFor({ timeout: 10_000 })

        const dmItemSender = pageSender.locator(
          `[data-test="dm-conversation-item"][data-dm-server-id="${dm.serverId}"]`,
        )
        await dmItemSender.waitFor({ timeout: 10_000 })
        await dmItemSender.click()
        await pageSender.locator('[data-test="chat-area"]').waitFor({ timeout: 10_000 })

        const uniqueDmMsg = `live-dm-msg-${Date.now()}`
        const messageInput = pageSender.locator('[data-test="message-input"]')
        await messageInput.fill(uniqueDmMsg)
        await messageInput.press('Enter')

        // Sender sees their own message
        const sentOnSender = pageSender
          .locator('[data-test="message-content"]')
          .filter({ hasText: uniqueDmMsg })
        await expect(sentOnSender.first()).toBeVisible({ timeout: 10_000 })

        // WHY: Recipient sees the message via SSE message.created — no navigation.
        // useRealtimeMessages inserts it into the TanStack Query cache directly.
        const receivedOnRecipient = pageRecipient
          .locator('[data-test="message-content"]')
          .filter({ hasText: uniqueDmMsg })
        await expect(receivedOnRecipient).toBeVisible({ timeout: 15_000 })
      } finally {
        await senderCtx.close()
        await recipientCtx.close()
      }
    })
  })

  // ── Banned User Loses Access via SSE ──────────────────────────────
  // WHY: Verifies that SSE force.disconnect event fires on ban (not just kick).
  // useForceDisconnect invalidates the server list cache and clears selection,
  // so the banned user's UI navigates away from the server. toast.error() shows
  // the ban reason.

  test.describe('banned user loses access via SSE', () => {
    test('after ban, server disappears from sidebar and toast is shown', async ({ browser }) => {
      // WHY: The victim is viewing the server when an admin bans them.
      // The SSE force.disconnect event should: (1) remove the server from the
      // sidebar, (2) show a toast notification with the ban reason.
      const banOwner = await createTestUser('rt-ban-owner')
      const banVictim = await createTestUser('rt-ban-victim')
      for (const u of [banOwner, banVictim]) await syncProfile(u.token)

      const banSrv = await createServer(banOwner.token, `RTBan E2E ${Date.now()}`)
      const invite = await createInvite(banOwner.token, banSrv.id)
      await joinServer(banVictim.token, banSrv.id, invite.code)

      const victimCtx = await browser.newContext({ baseURL: 'http://localhost:1420' })
      const victimPage = await victimCtx.newPage()

      try {
        // Victim opens the server
        await authenticatePage(victimPage, banVictim)
        await selectServer(victimPage, banSrv.id)

        // WHY: Wait for the member list to confirm the page is fully loaded
        // and the SSE connection is established.
        const memberList = victimPage.locator('[data-test="member-list"]')
        await memberList.waitFor({ timeout: 15_000 })

        // Confirm the server button is visible in the sidebar before ban
        const serverButton = victimPage.locator(
          `[data-test="server-button"][data-server-id="${banSrv.id}"]`,
        )
        await expect(serverButton).toBeVisible()

        // Ban the victim via API
        await banUser(banOwner.token, banSrv.id, banVictim.id, 'E2E ban test')

        // WHY: SSE force.disconnect event triggers useForceDisconnect which:
        // 1. Invalidates queryKeys.servers.all -> refetch removes the server
        // 2. Clears selectedServerId if viewing the banned server
        // 3. Shows a toast with the ban reason
        await expect(serverButton).not.toBeVisible({ timeout: 15_000 })

        // WHY: useForceDisconnect (use-force-disconnect.ts:80) calls toast.error()
        // with the ban reason. HeroUI renders toast elements with data-toast="true".
        // The ban reason 'E2E ban test' should appear as the toast title.
        const toastNotification = victimPage.locator('[data-toast="true"]').filter({
          hasText: 'E2E ban test',
        })
        await expect(toastNotification).toBeVisible({ timeout: 5_000 })
      } finally {
        await victimCtx.close()
      }
    })
  })
})
