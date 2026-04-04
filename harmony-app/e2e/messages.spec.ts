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

/**
 * Messaging E2E tests.
 *
 * Setup: owner (role=owner), moderator (role=moderator), member (role=member).
 * Server with a default #general channel for all messaging tests.
 */
test.describe('Messaging', () => {
  let owner: TestUser
  let moderator: TestUser
  let member: TestUser
  let server: { id: string; name: string }
  let channelId: string

  test.beforeAll(async () => {
    owner = await createTestUser('msg-owner')
    moderator = await createTestUser('msg-mod')
    member = await createTestUser('msg-member')
    await syncProfile(owner.token)
    await syncProfile(moderator.token)
    await syncProfile(member.token)

    server = await createServer(owner.token, `msg-test-${Date.now()}`)

    // Get the auto-created #general channel
    const channelList = await getServerChannels(owner.token, server.id)
    const gen = channelList.items.find((c) => c.name === 'general')
    if (gen === undefined) {
      throw new Error('Expected #general channel to exist after server creation')
    }
    channelId = gen.id

    // Invite and join moderator + member
    const invite = await createInvite(owner.token, server.id)
    await joinServer(moderator.token, server.id, invite.code)
    await joinServer(member.token, server.id, invite.code)

    // Assign moderator role
    await assignRole(owner.token, server.id, moderator.id, 'moderator')
  })

  // ── Send message ──────────────────────────────────────────────────

  test('send message appears in chat immediately', async ({ page }) => {
    await authenticatePage(page, member)
    await selectServer(page, server.id)
    await selectChannel(page, 'general')

    const messageInput = page.locator('[data-test="message-input"]')
    await messageInput.fill('Hello from E2E member')
    await expect(messageInput).toHaveValue('Hello from E2E member')

    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/v1/channels/${channelId}/messages`) &&
        response.request().method() === 'POST',
    )

    await messageInput.press('Enter')

    const response = await responsePromise
    expect(response.status()).toBe(201)

    // Message appears in the chat
    const newMessage = page
      .locator('[data-test="message-content"]')
      .filter({ hasText: 'Hello from E2E member' })
    await expect(newMessage.first()).toBeVisible({ timeout: 10_000 })
  })

  // ── Message shows author name and timestamp ───────────────────────

  test('message shows author name and timestamp', async ({ page }) => {
    // WHY: Send from owner first to break any message grouping from prior tests,
    // then send the target message from member. This guarantees member's message
    // starts a new group (different author) and renders the full header with
    // author name and timestamp.
    await sendMessage(owner.token, channelId, 'grouping-breaker')
    const msg = await sendMessage(member.token, channelId, 'Author timestamp test')

    await authenticatePage(page, member)
    await selectServer(page, server.id)
    await selectChannel(page, 'general')

    // Find the message by content
    const messageItem = page.locator(`[data-test="message-item"][data-message-id="${msg.id}"]`)
    await expect(messageItem).toBeVisible({ timeout: 10_000 })

    // Verify author is shown
    const authorEl = messageItem.locator('[data-test="message-author"]')
    await expect(authorEl).toBeVisible({ timeout: 5_000 })
    await expect(authorEl).toContainText(/.+/)

    // Verify timestamp is shown (format: "HH:MM" or locale date string)
    const timestampEl = messageItem.locator('[data-test="message-timestamp"]')
    await expect(timestampEl).toBeVisible()
    await expect(timestampEl).toContainText(/.+/)
  })

  // ── Edit own message ──────────────────────────────────────────────

  test('edit own message updates content and shows edited indicator', async ({ page }) => {
    // Send a message via API first
    const msg = await sendMessage(member.token, channelId, 'Before edit')

    await authenticatePage(page, member)
    await selectServer(page, server.id)
    await selectChannel(page, 'general')

    // Find the message
    const messageItem = page.locator(`[data-test="message-item"][data-message-id="${msg.id}"]`)
    await expect(messageItem).toBeVisible({ timeout: 10_000 })

    // Verify content BEFORE edit
    const contentEl = messageItem.locator('[data-test="message-content"]')
    await expect(contentEl).toHaveText('Before edit')

    // Verify no edited indicator before edit
    const editedIndicator = messageItem.locator('[data-test="message-edited-indicator"]')
    await expect(editedIndicator).toHaveCount(0)

    // Hover to reveal edit button
    await messageItem.hover()
    const editButton = messageItem.locator('[data-test="message-edit-button"]')
    await expect(editButton).toBeVisible({ timeout: 5_000 })
    await editButton.click()

    // Edit input appears
    const editInput = messageItem.locator('[data-test="message-edit-input"]')
    await expect(editInput).toBeVisible({ timeout: 5_000 })

    // Clear and type new content
    await editInput.clear()
    await editInput.fill('After edit')
    await expect(editInput).toHaveValue('After edit')

    // Submit via Enter and wait for PATCH
    const patchPromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/v1/channels/${channelId}/messages/${msg.id}`) &&
        response.request().method() === 'PATCH',
    )

    await editInput.press('Enter')

    const patchResponse = await patchPromise
    expect(patchResponse.status()).toBe(200)

    // Verify content AFTER edit
    await expect(contentEl).toHaveText(/After edit/)

    // Verify edited indicator appears
    await expect(editedIndicator).toBeVisible({ timeout: 10_000 })
    await expect(editedIndicator).toHaveText('(edited)')
  })

  // ── Delete own message ────────────────────────────────────────────

  test('delete own message shows tombstone', async ({ page }) => {
    // Send a message via API first
    const msg = await sendMessage(member.token, channelId, 'Message to self-delete')

    await authenticatePage(page, member)
    await selectServer(page, server.id)
    await selectChannel(page, 'general')

    // Find the message
    const messageItem = page.locator(`[data-test="message-item"][data-message-id="${msg.id}"]`)
    await expect(messageItem).toBeVisible({ timeout: 10_000 })

    // Verify content BEFORE deletion
    const contentEl = messageItem.locator('[data-test="message-content"]')
    await expect(contentEl).toHaveText('Message to self-delete')

    // Hover to reveal delete button
    await messageItem.hover()
    const deleteButton = messageItem.locator('[data-test="message-delete-button"]')
    await expect(deleteButton).toBeVisible({ timeout: 5_000 })

    // Click delete and wait for DELETE response
    const deletePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/v1/channels/${channelId}/messages/${msg.id}`) &&
        response.request().method() === 'DELETE',
    )

    await deleteButton.click()

    const deleteResponse = await deletePromise
    expect(deleteResponse.status()).toBe(204)

    // WHY: SSE delivers message.deleted events in real-time. The hook
    // (use-realtime-messages.ts:handleMessageDeleted) sets deletedBy on the
    // message in the TanStack Query cache, causing message-item.tsx to render
    // the deleted tombstone (data-test-deleted="true") without any reload.
    const deletedContent = page.locator(
      `[data-test="message-item"][data-message-id="${msg.id}"] [data-test="message-content"][data-test-deleted="true"]`,
    )
    await expect(deletedContent).toBeVisible({ timeout: 15_000 })
  })

  // ── Moderator deletes another's message ───────────────────────────

  test('moderator deletes another user message shows moderator tombstone', async ({ page }) => {
    // Member sends a message, moderator will delete it
    const msg = await sendMessage(member.token, channelId, 'Mod will delete this')

    await authenticatePage(page, moderator)
    await selectServer(page, server.id)
    await selectChannel(page, 'general')

    // Find the message
    const messageItem = page.locator(`[data-test="message-item"][data-message-id="${msg.id}"]`)
    await expect(messageItem).toBeVisible({ timeout: 10_000 })

    // Verify content BEFORE deletion
    const contentEl = messageItem.locator('[data-test="message-content"]')
    await expect(contentEl).toHaveText('Mod will delete this')

    // Hover to reveal delete button (moderator can delete others' messages)
    await messageItem.hover()
    const deleteButton = messageItem.locator('[data-test="message-delete-button"]')
    await expect(deleteButton).toBeVisible({ timeout: 5_000 })

    // Click delete and wait for DELETE response
    const deletePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/v1/channels/${channelId}/messages/${msg.id}`) &&
        response.request().method() === 'DELETE',
    )

    await deleteButton.click()

    const deleteResponse = await deletePromise
    expect(deleteResponse.status()).toBe(204)

    // WHY: SSE delivers message.deleted events in real-time. The hook
    // (use-realtime-messages.ts:handleMessageDeleted) sets deletedBy on the
    // message in the TanStack Query cache, causing message-item.tsx to render
    // the moderator-deleted tombstone (data-test-deleted="true") without reload.
    const deletedContent = page.locator(
      `[data-test="message-item"][data-message-id="${msg.id}"] [data-test="message-content"][data-test-deleted="true"]`,
    )
    await expect(deletedContent).toBeVisible({ timeout: 15_000 })
  })

  // ── Non-author cannot edit ────────────────────────────────────────

  test('non-author cannot see edit button on another user message', async ({ page }) => {
    // Owner sends a message
    const msg = await sendMessage(owner.token, channelId, 'Owner-only editable')

    await authenticatePage(page, member)
    await selectServer(page, server.id)
    await selectChannel(page, 'general')

    // Find the message
    const messageItem = page.locator(`[data-test="message-item"][data-message-id="${msg.id}"]`)
    await expect(messageItem).toBeVisible({ timeout: 10_000 })

    // Hover — member should NOT see edit button (only owner can edit their own)
    await messageItem.hover()

    const editButton = messageItem.locator('[data-test="message-edit-button"]')
    await expect(editButton).toHaveCount(0)
  })

  // ── Member cannot delete another's message ────────────────────────

  test('member cannot see delete button on another user message', async ({ page }) => {
    // Owner sends a message
    const msg = await sendMessage(owner.token, channelId, 'Member cannot delete this')

    await authenticatePage(page, member)
    await selectServer(page, server.id)
    await selectChannel(page, 'general')

    // Find the message
    const messageItem = page.locator(`[data-test="message-item"][data-message-id="${msg.id}"]`)
    await expect(messageItem).toBeVisible({ timeout: 10_000 })

    // Hover — member should NOT see edit or delete buttons (not own message + not moderator).
    // WHY: The actions bar IS visible because it contains the reply button (available to all).
    // We specifically assert that destructive actions (edit, delete) are absent.
    await messageItem.hover()

    const editButton = messageItem.locator('[data-test="message-edit-button"]')
    await expect(editButton).toHaveCount(0)

    const deleteButton = messageItem.locator('[data-test="message-delete-button"]')
    await expect(deleteButton).toHaveCount(0)
  })

  // ── Pagination: scroll up to load older messages ──────────────────

  test('messages load with cursor pagination on scroll', async ({ page }) => {
    // WHY: Create a fresh channel and populate with >50 messages (default page size)
    // to trigger pagination. API default limit is 50.
    //
    // Two rate limits apply:
    //   1. SpamGuard: 15 msgs / 30s per (user, server) — Admin/Owner bypass.
    //   2. Per-plan DB rate limit: 5 msgs / 5s per (user, channel) — no bypass.
    //
    // Strategy: 4 users × 5 msgs per batch = 20 per batch, with 5.5s pauses
    // between batches for the 5s rate-limit window to slide. 3 batches × 20 = 60.
    // Per non-admin user: 15 msgs in 11s — at SpamGuard threshold (≥15 triggers
    // mute but the 15th message itself is sent; no 16th batch needed).
    // Owner bypasses SpamGuard regardless. Extra helper user created for this test.
    const paginationChannel = await createChannel(owner.token, server.id, 'pagination-test')

    // WHY: 5 users × 4 msgs/batch × 3 batches = 60 msgs, 12 per user.
    // Per-plan: 4 < 5/5s Free limit ✅. SpamGuard: 12 < 15/30s threshold ✅.
    // Owner bypasses SpamGuard regardless. Extra users created for this test only.
    const helper1 = await createTestUser('msg-helper1')
    const helper2 = await createTestUser('msg-helper2')
    await syncProfile(helper1.token)
    await syncProfile(helper2.token)
    const helperInvite = await createInvite(owner.token, server.id)
    await joinServer(helper1.token, server.id, helperInvite.code)
    const helperInvite2 = await createInvite(owner.token, server.id)
    await joinServer(helper2.token, server.id, helperInvite2.code)

    const users = [owner, moderator, member, helper1, helper2]
    const MSGS_PER_USER_PER_BATCH = 4
    const TOTAL_BATCHES = 3
    const RATE_LIMIT_WINDOW_MS = 5_500

    for (let batch = 0; batch < TOTAL_BATCHES; batch++) {
      const batchPromises: Promise<unknown>[] = []
      for (const user of users) {
        for (let j = 0; j < MSGS_PER_USER_PER_BATCH; j++) {
          const msgNum =
            batch * users.length * MSGS_PER_USER_PER_BATCH +
            users.indexOf(user) * MSGS_PER_USER_PER_BATCH +
            j +
            1
          batchPromises.push(
            sendMessage(user.token, paginationChannel.id, `Pagination msg ${msgNum}`),
          )
        }
      }
      await Promise.all(batchPromises)
      const isLastBatch = batch === TOTAL_BATCHES - 1
      if (!isLastBatch) {
        await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_WINDOW_MS))
      }
    }

    await authenticatePage(page, owner)
    await selectServer(page, server.id)
    await selectChannel(page, 'pagination-test')

    // Wait for first page of messages to load
    const messageList = page.locator('[data-test="message-list"]')
    await messageList.waitFor({ timeout: 10_000 })

    const messageItems = page.locator('[data-test="message-item"]')
    await messageItems.first().waitFor({ timeout: 10_000 })

    // Initial load: up to 50 messages (default page size)
    const initialCount = await messageItems.count()
    expect(initialCount).toBeGreaterThanOrEqual(1)
    expect(initialCount).toBeLessThanOrEqual(50)

    // Scroll to top to trigger pagination fetch
    const paginationPromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/v1/channels/${paginationChannel.id}/messages`) &&
        response.url().includes('before=') &&
        response.request().method() === 'GET',
      { timeout: 15_000 },
    )

    await messageList.evaluate((el) => {
      el.scrollTop = 0
    })

    const paginationResponse = await paginationPromise
    expect(paginationResponse.status()).toBe(200)

    // WHY: The virtualizer renders a fixed window of items. Scrolling up to
    // trigger pagination does NOT necessarily increase the DOM count because
    // the virtualizer removes off-screen items as it adds new ones. Instead,
    // we verify that the pagination response returned additional message items.
    const paginationBody = (await paginationResponse.json()) as Record<string, unknown>
    const paginatedItems = paginationBody.items
    expect(Array.isArray(paginatedItems)).toBe(true)
    expect((paginatedItems as unknown[]).length).toBeGreaterThan(0)
  })

  // ── Empty channel shows empty state ───────────────────────────────

  test('empty channel shows empty state', async ({ page }) => {
    // Create a fresh empty channel
    await createChannel(owner.token, server.id, 'empty-test')

    await authenticatePage(page, owner)
    await selectServer(page, server.id)
    await selectChannel(page, 'empty-test')

    // Empty state should be visible
    const emptyState = page.locator('[data-test="empty-state"]')
    await expect(emptyState).toBeVisible({ timeout: 10_000 })

    // No message items should exist
    const messageItems = page.locator('[data-test="message-item"]')
    await expect(messageItems).toHaveCount(0)
  })

  // ── Empty message rejected ────────────────────────────────────────

  test('empty message is not sent (client-side trim check)', async ({ page }) => {
    await authenticatePage(page, member)
    await selectServer(page, server.id)
    await selectChannel(page, 'general')

    const messageInput = page.locator('[data-test="message-input"]')

    // Fill with only whitespace
    await messageInput.fill('   ')
    await expect(messageInput).toHaveValue('   ')

    // WHY: handleSend() trims content and returns early if empty.
    // No POST request should be made.
    await messageInput.press('Enter')

    // WHY: If the message was NOT sent, the input still contains the whitespace.
    // The handleSend function clears input only on successful send.
    await expect(messageInput).toHaveValue('   ')
  })

  // ── Message over 4000 chars rejected by API ───────────────────────

  test('message over 4000 chars is rejected by API', async ({ page }) => {
    await authenticatePage(page, member)
    await selectServer(page, server.id)
    await selectChannel(page, 'general')

    const messageInput = page.locator('[data-test="message-input"]')

    // WHY: Generate a 4001-char string. fill() clears the input then types the
    // full value, triggering HeroUI's onValueChange for controlled state updates.
    const longContent = 'A'.repeat(4001)
    await messageInput.fill(longContent)

    // WHY: Verify the controlled state accepted the input before pressing Enter.
    // Without this, a race between fill() and React re-render could leave
    // messageContent empty, causing handleSend() to bail and no POST to fire.
    await expect(messageInput).toHaveValue(longContent)

    // WHY: Register the response listener BEFORE pressing Enter to avoid
    // missing the POST response on fast connections.
    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/v1/channels/${channelId}/messages`) &&
        response.request().method() === 'POST',
    )

    await messageInput.press('Enter')

    const response = await responsePromise
    // WHY: Server validates max 4000 chars → 400 Bad Request (DomainError::ValidationError)
    expect(response.status()).toBe(400)
  })
})
