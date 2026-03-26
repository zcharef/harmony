import { expect, test } from '@playwright/test'
import { authenticatePage, selectChannel, selectServer } from './fixtures/auth-fixture'
import {
  assignRole,
  createChannel,
  createInvite,
  createServer,
  getServerChannels,
  joinServer,
  syncProfile,
} from './fixtures/test-data-factory'
import { createTestUser, type TestUser } from './fixtures/user-factory'

/**
 * Channel CRUD E2E tests.
 *
 * Setup: owner (role=owner), admin (role=admin), member (role=member).
 * Server with 4 channels: #general (auto), #extra, #secret (private), #announcements (read-only).
 */
test.describe('Channel CRUD', () => {
  let owner: TestUser
  let admin: TestUser
  let member: TestUser
  let server: { id: string; name: string }
  let extraChannel: { id: string; name: string }
  let announcementsChannel: { id: string; name: string }

  test.beforeAll(async () => {
    owner = await createTestUser('ch-owner')
    admin = await createTestUser('ch-admin')
    member = await createTestUser('ch-member')
    await syncProfile(owner.token)
    await syncProfile(admin.token)
    await syncProfile(member.token)

    server = await createServer(owner.token, `ch-test-${Date.now()}`)

    // Owner creates additional channels via API
    extraChannel = await createChannel(owner.token, server.id, 'extra')
    await createChannel(owner.token, server.id, 'secret', { isPrivate: true })
    announcementsChannel = await createChannel(owner.token, server.id, 'announcements', {
      isReadOnly: true,
    })

    // Invite and join admin + member
    const invite = await createInvite(owner.token, server.id)
    await joinServer(admin.token, server.id, invite.code)
    await joinServer(member.token, server.id, invite.code)

    // Assign admin role
    await assignRole(owner.token, server.id, admin.id, 'admin')
  })

  // ── Admin creates a channel via the UI ────────────────────────────

  test('admin can create a channel via the UI', async ({ page }) => {
    await authenticatePage(page, admin)
    await selectServer(page, server.id)

    // Verify initial channel count (admin sees all 4: general, extra, secret, announcements)
    const channelButtons = page.locator('[data-test="channel-button"]')
    await expect(channelButtons).toHaveCount(4, { timeout: 10_000 })

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
    await nameInput.fill('ui-created')
    await expect(nameInput).toHaveValue('ui-created')

    // Submit and wait for API response
    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/v1/servers/${server.id}/channels`) &&
        response.request().method() === 'POST',
    )

    await page.locator('[data-test="create-channel-submit-button"]').click()

    const response = await responsePromise
    expect(response.status()).toBe(201)

    // Dialog closes
    await expect(dialog).not.toBeVisible({ timeout: 5_000 })

    // New channel appears in sidebar
    const newChannelButton = page
      .locator('[data-test="channel-button"]')
      .filter({ hasText: 'ui-created' })
    await expect(newChannelButton).toBeVisible({ timeout: 10_000 })

    // Count increased by 1
    await expect(channelButtons).toHaveCount(5, { timeout: 10_000 })
  })

  // ── Admin edits a channel name and topic ──────────────────────────

  test('admin can edit a channel name and topic', async ({ page }) => {
    await authenticatePage(page, admin)
    await selectServer(page, server.id)

    // Hover over #extra to reveal settings cog
    const extraBtn = page.locator('[data-test="channel-button"]').filter({ hasText: 'extra' })
    await extraBtn.waitFor({ timeout: 10_000 })

    // Hover the channel item wrapper to show the settings button
    const channelRow = page.locator('[data-test="channel-item"]').filter({ hasText: 'extra' })
    await channelRow.hover()

    const settingsBtn = channelRow.locator('[data-test="channel-settings-button"]')
    await expect(settingsBtn).toBeVisible({ timeout: 5_000 })
    await settingsBtn.click()

    // Click "Edit" in dropdown
    // WHY: HeroUI dropdown animates in — wait for the item to be visible and stable.
    const editItem = page.locator('[data-test="channel-edit-item"]')
    await editItem.waitFor({ timeout: 5_000 })
    await editItem.click()

    // Edit dialog appears
    const editDialog = page.locator('[data-test="edit-channel-dialog"]')
    await expect(editDialog).toBeVisible({ timeout: 5_000 })

    // Change name
    const editNameInput = page.locator('[data-test="edit-channel-name-input"]')
    await editNameInput.clear()
    await editNameInput.fill('extra-renamed')
    await expect(editNameInput).toHaveValue('extra-renamed')

    // Set topic
    const editTopicInput = page.locator('[data-test="edit-channel-topic-input"]')
    await editTopicInput.fill('A test topic')
    await expect(editTopicInput).toHaveValue('A test topic')

    // Submit and wait for PATCH response
    const patchPromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/v1/servers/${server.id}/channels/${extraChannel.id}`) &&
        response.request().method() === 'PATCH',
    )

    await page.locator('[data-test="edit-channel-submit-button"]').click()

    const patchResponse = await patchPromise
    expect(patchResponse.status()).toBe(200)

    // Dialog closes
    await expect(editDialog).not.toBeVisible({ timeout: 5_000 })

    // Updated name visible in sidebar
    const renamedBtn = page
      .locator('[data-test="channel-button"]')
      .filter({ hasText: 'extra-renamed' })
    await expect(renamedBtn).toBeVisible({ timeout: 10_000 })
  })

  // ── Admin deletes a channel ───────────────────────────────────────

  test('admin can delete a non-last channel', async ({ page }) => {
    // WHY: Create a throwaway channel for this test so we don't destroy
    // shared test data from other tests.
    const throwaway = await createChannel(admin.token, server.id, 'throwaway')

    await authenticatePage(page, admin)
    await selectServer(page, server.id)

    // Verify throwaway channel is visible
    const throwawayBtn = page
      .locator('[data-test="channel-button"]')
      .filter({ hasText: 'throwaway' })
    await expect(throwawayBtn).toBeVisible({ timeout: 10_000 })

    const channelButtons = page.locator('[data-test="channel-button"]')
    const countBefore = await channelButtons.count()

    // Hover to reveal settings
    const channelRow = page.locator('[data-test="channel-item"]').filter({ hasText: 'throwaway' })
    await channelRow.hover()

    const settingsBtn = channelRow.locator('[data-test="channel-settings-button"]')
    await expect(settingsBtn).toBeVisible({ timeout: 5_000 })
    await settingsBtn.click()

    // Accept the confirm dialog that will appear
    page.on('dialog', (dialog) => dialog.accept())

    // Click "Delete" in dropdown
    const deleteResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/v1/servers/${server.id}/channels/${throwaway.id}`) &&
        response.request().method() === 'DELETE',
    )

    // WHY: HeroUI dropdown animates in — wait for the item to be visible and stable.
    const deleteItem = page.locator('[data-test="channel-delete-item"]')
    await deleteItem.waitFor({ timeout: 5_000 })
    await deleteItem.click()

    const deleteResponse = await deleteResponsePromise
    expect(deleteResponse.status()).toBe(204)

    // Channel disappears from sidebar
    await expect(throwawayBtn).not.toBeVisible({ timeout: 10_000 })

    await expect(channelButtons).toHaveCount(countBefore - 1, { timeout: 10_000 })
  })

  // ── Cannot delete the last channel ────────────────────────────────

  test('cannot delete the last channel in a server', async ({ page }) => {
    // WHY: Create a fresh server with only the auto-created #general channel.
    const loneServer = await createServer(owner.token, `lone-${Date.now()}`)
    const loneChannelList = await getServerChannels(owner.token, loneServer.id)
    expect(loneChannelList.items.length).toBe(1)

    await authenticatePage(page, owner)
    await selectServer(page, loneServer.id)

    // Verify only one channel visible
    const channelButtons = page.locator('[data-test="channel-button"]')
    await expect(channelButtons).toHaveCount(1, { timeout: 10_000 })

    // Hover to reveal settings
    const channelRow = page.locator('[data-test="channel-item"]').first()
    await channelRow.hover()

    const settingsBtn = channelRow.locator('[data-test="channel-settings-button"]')
    await expect(settingsBtn).toBeVisible({ timeout: 5_000 })
    await settingsBtn.click()

    // Accept the confirm dialog
    page.on('dialog', (dialog) => dialog.accept())

    // Click delete — API will reject with 400
    const deleteResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/v1/servers/${loneServer.id}/channels/`) &&
        response.request().method() === 'DELETE',
    )

    // WHY: HeroUI dropdown animates in — wait for the item to be visible and stable.
    const deleteItem = page.locator('[data-test="channel-delete-item"]')
    await deleteItem.waitFor({ timeout: 5_000 })
    await deleteItem.click()

    const deleteResponse = await deleteResponsePromise
    expect(deleteResponse.status()).toBe(400)

    // Channel is still visible (not removed)
    await expect(channelButtons.first()).toBeVisible()
    await expect(channelButtons).toHaveCount(1)
  })

  // ── Member cannot see channel management controls ─────────────────

  test('member cannot see create/edit/delete channel controls', async ({ page }) => {
    await authenticatePage(page, member)
    await selectServer(page, server.id)

    // Wait for channels to load
    const channelButtons = page.locator('[data-test="channel-button"]')
    await channelButtons.first().waitFor({ timeout: 10_000 })

    // Verify no settings cog is visible on any channel (even on hover)
    const firstChannelRow = page.locator('[data-test="channel-item"]').first()
    await firstChannelRow.hover()

    const settingsBtns = page.locator('[data-test="channel-settings-button"]')
    await expect(settingsBtns).toHaveCount(0)

    // Open server menu — create-channel and settings items should be hidden
    await page.locator('[data-test="server-header-button"]').click()

    const createChannelItem = page.locator('[data-test="server-menu-create-channel-item"]')
    // WHY: The item has className 'hidden' when canAccessSettings is false,
    // so it exists in DOM but is not visible.
    await expect(createChannelItem).not.toBeVisible()

    const settingsItem = page.locator('[data-test="server-menu-settings-item"]')
    await expect(settingsItem).not.toBeVisible()
  })

  // ── Private channel: member without access cannot see it ──────────

  test('member cannot see a private channel', async ({ page }) => {
    await authenticatePage(page, member)
    await selectServer(page, server.id)

    // Wait for channels to load
    const channelButtons = page.locator('[data-test="channel-button"]')
    await channelButtons.first().waitFor({ timeout: 10_000 })

    // Member should NOT see the #secret private channel
    const secretBtn = page.locator('[data-test="channel-button"]').filter({ hasText: 'secret' })
    await expect(secretBtn).toHaveCount(0)

    // Member SHOULD see non-private channels (general, announcements)
    const generalBtn = page.locator('[data-test="channel-button"]').filter({ hasText: 'general' })
    await expect(generalBtn).toBeVisible()
  })

  // ── Private channel: admin can see it ─────────────────────────────

  test('admin can see a private channel', async ({ page }) => {
    await authenticatePage(page, admin)
    await selectServer(page, server.id)

    const channelButtons = page.locator('[data-test="channel-button"]')
    await channelButtons.first().waitFor({ timeout: 10_000 })

    // Admin should see the #secret private channel
    const secretBtn = page.locator('[data-test="channel-button"]').filter({ hasText: 'secret' })
    await expect(secretBtn).toBeVisible()
  })

  // ── Read-only channel: member cannot post ─────────────────────────

  test('member sees read-only channel but cannot post', async ({ page }) => {
    await authenticatePage(page, member)
    await selectServer(page, server.id)
    await selectChannel(page, 'announcements')

    // Chat area loads
    const chatArea = page.locator('[data-test="chat-area"]')
    await expect(chatArea).toBeVisible({ timeout: 10_000 })

    // Message input should be read-only (isReadOnly prop makes Textarea isReadOnly=true)
    const messageInput = page.locator('[data-test="message-input"]')
    await expect(messageInput).toBeVisible()

    // WHY: HeroUI Textarea with isReadOnly={true} sets aria-readonly="true" on
    // the native <textarea> element (via React Aria). data-test lands on the native
    // textarea, so we assert on aria-readonly which lives on that same element.
    await expect(messageInput).toHaveAttribute('aria-readonly', 'true')
  })

  // ── Read-only channel: admin can post ─────────────────────────────

  test('admin can post in a read-only channel', async ({ page }) => {
    await authenticatePage(page, admin)
    await selectServer(page, server.id)
    await selectChannel(page, 'announcements')

    // Chat area loads
    const chatArea = page.locator('[data-test="chat-area"]')
    await expect(chatArea).toBeVisible({ timeout: 10_000 })

    // Message input should NOT be readonly for admin
    const messageInput = page.locator('[data-test="message-input"]')
    await expect(messageInput).toBeVisible()
    // WHY: aria-readonly is absent when isReadOnly is false for admin users.
    await expect(messageInput).not.toHaveAttribute('aria-readonly', 'true')

    // Admin can send a message
    await messageInput.fill('Admin announcement')
    await expect(messageInput).toHaveValue('Admin announcement')

    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/v1/channels/${announcementsChannel.id}/messages`) &&
        response.request().method() === 'POST',
    )

    await messageInput.press('Enter')

    const response = await responsePromise
    expect(response.status()).toBe(201)

    // Message appears
    const newMessage = page
      .locator('[data-test="message-content"]')
      .filter({ hasText: 'Admin announcement' })
    await expect(newMessage.first()).toBeVisible({ timeout: 10_000 })
  })
})
