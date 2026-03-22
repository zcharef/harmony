/**
 * E2E Tests — Encryption UI Features
 *
 * Verifies that E2EE-related UI elements behave correctly on the web client:
 * - Encryption toggle visibility based on role (owner-only) and platform (disabled on web)
 * - Encrypted channel badge in the sidebar after enabling encryption via API
 * - EncryptionRequiredBanner shown on web for encrypted channels
 * - E2EE alpha banner shown in the toolbar for encrypted channels
 * - Message input disabled on web for encrypted channels
 *
 * WHY web-only scope: The Playwright tests run against the Vite dev server (not Tauri).
 * On web, isTauri() returns false, so the encryption toggle is disabled (desktop-only)
 * and the message input is blocked for encrypted channels. These tests verify those
 * guards work correctly and that the API-level encryption flag is reflected in the UI.
 *
 * Real data-test attributes from:
 * - channels-tab.tsx:160 (channel-encryption-toggle), :175 (channel-encryption-toggle-disabled)
 * - channels-tab.tsx:125 (settings-channel-row), :139 (channel-encrypted-icon)
 * - channel-sidebar.tsx:57 (channel-button), :73 (EncryptedChannelBadge)
 * - encrypted-channel-badge.tsx:21 (encrypted-channel-badge)
 * - encryption-required-banner.tsx:20 (encryption-required-banner)
 * - e2ee-alpha-banner.tsx:17 (e2ee-alpha-banner)
 * - chat-area.tsx:341 (message-input), :820 (chat-area)
 * - encrypted-channel-notice.tsx:41 (encrypted-channel-notice)
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
  syncProfile,
  updateChannel,
  updateChannelRaw,
} from './fixtures/test-data-factory'
import { createTestUser, type TestUser } from './fixtures/user-factory'

test.describe('Encryption UI', () => {
  let owner: TestUser
  let admin: TestUser
  let member: TestUser
  let server: { id: string; name: string }
  let encryptedChannel: { id: string; name: string }
  let plainChannel: { id: string; name: string }

  test.beforeAll(async () => {
    owner = await createTestUser('enc-owner')
    admin = await createTestUser('enc-admin')
    member = await createTestUser('enc-member')
    for (const u of [owner, admin, member]) await syncProfile(u.token)

    server = await createServer(owner.token, `Encryption E2E ${Date.now()}`)

    // WHY: Create two channels — one will be encrypted via API, the other stays plain.
    // This allows testing both states in the same server context.
    encryptedChannel = await createChannel(owner.token, server.id, 'secret-channel')
    plainChannel = await createChannel(owner.token, server.id, 'plain-channel')

    // Enable encryption on the channel via API (owner-only operation).
    await updateChannel(owner.token, server.id, encryptedChannel.id, { encrypted: true })

    const invite = await createInvite(owner.token, server.id)
    for (const u of [admin, member]) await joinServer(u.token, server.id, invite.code)

    await assignRole(owner.token, server.id, admin.id, 'admin')
  })

  // ── Encryption toggle visibility (owner / web) ──────────────────────

  test('owner sees disabled encryption toggle on web (desktop-only guard)', async ({ page }) => {
    // WHY: channels-tab.tsx:167 — isOwner && !isDesktop renders channel-encryption-toggle-disabled.
    // On web, isTauri() is false, so the toggle is disabled with a "Desktop only" tooltip.
    await authenticatePage(page, owner)
    await selectServer(page, server.id)

    // Open server settings > Channels tab
    await page.locator('[data-test="server-header-button"]').click()
    await page.locator('[data-test="server-menu-settings-item"]').click()
    await page.locator('[data-test="server-settings"]').waitFor({ timeout: 10_000 })
    await page.locator('[data-test="settings-tab-channels"]').click()

    // Find the plain channel row (not yet encrypted)
    const channelList = page.locator('[data-test="settings-channel-list"]')
    await channelList.waitFor({ timeout: 10_000 })

    const plainRow = channelList.locator(
      `[data-test="settings-channel-row"][data-channel-id="${plainChannel.id}"]`,
    )
    await plainRow.waitFor({ timeout: 10_000 })

    // WHY: On web, the toggle should be present but disabled (data-test="channel-encryption-toggle-disabled").
    const disabledToggle = plainRow.locator('[data-test="channel-encryption-toggle-disabled"]')
    await expect(disabledToggle).toBeVisible()

    // The active (clickable) toggle should NOT be visible on web
    const activeToggle = plainRow.locator('[data-test="channel-encryption-toggle"]')
    await expect(activeToggle).not.toBeAttached()
  })

  test('admin does not see encryption toggle in channel settings', async ({ page }) => {
    // WHY: channels-tab.tsx:121 — canEnableEncryption requires isOwner.
    // Admin is not the owner, so neither the active nor disabled toggle should appear.
    await authenticatePage(page, admin)
    await selectServer(page, server.id)

    await page.locator('[data-test="server-header-button"]').click()
    await page.locator('[data-test="server-menu-settings-item"]').click()
    await page.locator('[data-test="server-settings"]').waitFor({ timeout: 10_000 })
    await page.locator('[data-test="settings-tab-channels"]').click()

    const channelList = page.locator('[data-test="settings-channel-list"]')
    await channelList.waitFor({ timeout: 10_000 })

    const plainRow = channelList.locator(
      `[data-test="settings-channel-row"][data-channel-id="${plainChannel.id}"]`,
    )
    await plainRow.waitFor({ timeout: 10_000 })

    // Neither active nor disabled encryption toggle should be visible for admin
    await expect(
      plainRow.locator('[data-test="channel-encryption-toggle"]'),
    ).not.toBeAttached()
    await expect(
      plainRow.locator('[data-test="channel-encryption-toggle-disabled"]'),
    ).not.toBeAttached()
  })

  // ── Encrypted channel icon in settings ────────────────────────────

  test('encrypted channel shows lock icon in settings channel row', async ({ page }) => {
    // WHY: channels-tab.tsx:137-139 — isEncrypted renders Lock with data-test="channel-encrypted-icon".
    await authenticatePage(page, owner)
    await selectServer(page, server.id)

    await page.locator('[data-test="server-header-button"]').click()
    await page.locator('[data-test="server-menu-settings-item"]').click()
    await page.locator('[data-test="server-settings"]').waitFor({ timeout: 10_000 })
    await page.locator('[data-test="settings-tab-channels"]').click()

    const channelList = page.locator('[data-test="settings-channel-list"]')
    await channelList.waitFor({ timeout: 10_000 })

    // Encrypted channel row should show the lock icon
    const encRow = channelList.locator(
      `[data-test="settings-channel-row"][data-channel-id="${encryptedChannel.id}"]`,
    )
    await encRow.waitFor({ timeout: 10_000 })
    await expect(encRow.locator('[data-test="channel-encrypted-icon"]')).toBeVisible()

    // Plain channel row should NOT show the lock icon
    const plainRow = channelList.locator(
      `[data-test="settings-channel-row"][data-channel-id="${plainChannel.id}"]`,
    )
    await plainRow.waitFor({ timeout: 10_000 })
    await expect(plainRow.locator('[data-test="channel-encrypted-icon"]')).not.toBeAttached()
  })

  // ── Encrypted channel badge in sidebar ────────────────────────────

  test('encrypted channel shows badge in sidebar', async ({ page }) => {
    // WHY: channel-sidebar.tsx:73 — channel.encrypted renders EncryptedChannelBadge
    // which has data-test="encrypted-channel-badge" (encrypted-channel-badge.tsx:21).
    await authenticatePage(page, owner)
    await selectServer(page, server.id)

    const channelList = page.locator('[data-test="channel-list"]')
    await channelList.waitFor({ timeout: 10_000 })

    // Encrypted channel button should have the badge
    const encButton = channelList.locator(
      `[data-test="channel-button"][data-channel-id="${encryptedChannel.id}"]`,
    )
    await encButton.waitFor({ timeout: 10_000 })
    await expect(encButton.locator('[data-test="encrypted-channel-badge"]')).toBeVisible()

    // Plain channel button should NOT have the badge
    const plainButton = channelList.locator(
      `[data-test="channel-button"][data-channel-id="${plainChannel.id}"]`,
    )
    await plainButton.waitFor({ timeout: 10_000 })
    await expect(plainButton.locator('[data-test="encrypted-channel-badge"]')).not.toBeAttached()
  })

  // ── Encrypted channel chat area (web restrictions) ────────────────

  test('encrypted channel shows encryption-required banner and disables input on web', async ({
    page,
  }) => {
    // WHY: chat-area.tsx:615 — (isDm || isChannelEncrypted) && !isTauri() renders EncryptionRequiredBanner.
    // WHY: chat-area.tsx:787 — isWebEncryptionBlocked disables the message input on web.
    await authenticatePage(page, owner)
    await selectServer(page, server.id)

    // Select the encrypted channel
    await selectChannel(page, encryptedChannel.name)

    const chatArea = page.locator('[data-test="chat-area"]')
    await chatArea.waitFor({ timeout: 10_000 })

    // EncryptionRequiredBanner should be visible on web
    await expect(page.locator('[data-test="encryption-required-banner"]')).toBeVisible({
      timeout: 10_000,
    })

    // Message input should be read-only on web for encrypted channels
    const messageInput = page.locator('[data-test="message-input"] textarea')
    await messageInput.waitFor({ timeout: 10_000 })

    // WHY: The Textarea has isReadOnly={isInputDisabled} when isWebEncryptionBlocked is true.
    // HeroUI renders this as readonly attribute on the underlying textarea element.
    const isReadOnly = await messageInput.getAttribute('readonly')
    expect(isReadOnly).not.toBeNull()
  })

  test('plain channel does NOT show encryption-required banner and allows input', async ({
    page,
  }) => {
    // WHY: Verify that the encryption guards only apply to encrypted channels.
    await authenticatePage(page, owner)
    await selectServer(page, server.id)

    await selectChannel(page, plainChannel.name)

    const chatArea = page.locator('[data-test="chat-area"]')
    await chatArea.waitFor({ timeout: 10_000 })

    // EncryptionRequiredBanner should NOT appear for plain channels
    await expect(page.locator('[data-test="encryption-required-banner"]')).not.toBeAttached()

    // Message input should be editable
    const messageInput = page.locator('[data-test="message-input"] textarea')
    await messageInput.waitFor({ timeout: 10_000 })

    const isReadOnly = await messageInput.getAttribute('readonly')
    expect(isReadOnly).toBeNull()
  })

  // ── E2EE alpha banner in toolbar ──────────────────────────────────

  test('encrypted channel shows E2EE alpha banner in toolbar', async ({ page }) => {
    // WHY: chat-area.tsx:289 — isChannelEncrypted renders E2eeAlphaBanner in ChatToolbar.
    await authenticatePage(page, owner)
    await selectServer(page, server.id)

    await selectChannel(page, encryptedChannel.name)

    const toolbar = page.locator('[data-test="chat-toolbar"]')
    await toolbar.waitFor({ timeout: 10_000 })

    await expect(toolbar.locator('[data-test="e2ee-alpha-banner"]')).toBeVisible()
  })

  test('plain channel does NOT show E2EE alpha banner in toolbar', async ({ page }) => {
    await authenticatePage(page, owner)
    await selectServer(page, server.id)

    await selectChannel(page, plainChannel.name)

    const toolbar = page.locator('[data-test="chat-toolbar"]')
    await toolbar.waitFor({ timeout: 10_000 })

    await expect(toolbar.locator('[data-test="e2ee-alpha-banner"]')).not.toBeAttached()
  })

  // ── Encrypted channel notice ──────────────────────────────────────

  test('encrypted channel shows dismissible notice banner', async ({ page }) => {
    // WHY: chat-area.tsx:675 — isChannelEncrypted renders EncryptedChannelNotice.
    await authenticatePage(page, owner)
    await selectServer(page, server.id)

    // WHY: Clear any previously dismissed state from localStorage.
    await page.evaluate((channelId) => {
      localStorage.removeItem(`harmony_encrypted_channel_notice_dismissed_${channelId}`)
    }, encryptedChannel.id)

    await selectChannel(page, encryptedChannel.name)

    const notice = page.locator('[data-test="encrypted-channel-notice"]')
    await expect(notice).toBeVisible({ timeout: 10_000 })

    // Dismiss the notice
    await page.locator('[data-test="encrypted-channel-notice-dismiss"]').click()
    await expect(notice).not.toBeAttached()
  })

  // ── API-level encryption enforcement ──────────────────────────────

  test('API rejects disabling encryption on an already-encrypted channel (one-way toggle)', async () => {
    // WHY: UpdateChannelRequest doc says "one-way toggle: once true, cannot be set back to false".
    // This verifies the API enforces that constraint.
    const result = await updateChannelRaw(owner.token, server.id, encryptedChannel.id, {
      encrypted: false,
    })

    // The API should reject the attempt to disable encryption (4xx).
    expect(result.status).toBeGreaterThanOrEqual(400)
  })

  test('API rejects non-owner enabling encryption', async () => {
    // WHY: Only the server owner should be able to enable encryption.
    const result = await updateChannelRaw(admin.token, server.id, plainChannel.id, {
      encrypted: true,
    })

    expect(result.status).toBeGreaterThanOrEqual(400)
  })

  // ── Encryption state persisted and visible to other roles ─────────

  test('member sees encrypted channel badge in sidebar', async ({ page }) => {
    // WHY: The encrypted state is persisted via API and reflected in the ChannelResponse.
    // All roles should see the encrypted badge, not just the owner who enabled it.
    await authenticatePage(page, member)
    await selectServer(page, server.id)

    const channelList = page.locator('[data-test="channel-list"]')
    await channelList.waitFor({ timeout: 10_000 })

    const encButton = channelList.locator(
      `[data-test="channel-button"][data-channel-id="${encryptedChannel.id}"]`,
    )
    await encButton.waitFor({ timeout: 10_000 })
    await expect(encButton.locator('[data-test="encrypted-channel-badge"]')).toBeVisible()
  })

  test('member sees encryption-required banner on encrypted channel', async ({ page }) => {
    // WHY: Members on web should also see the EncryptionRequiredBanner,
    // not just the owner. The banner is platform-gated, not role-gated.
    await authenticatePage(page, member)
    await selectServer(page, server.id)

    await selectChannel(page, encryptedChannel.name)

    const chatArea = page.locator('[data-test="chat-area"]')
    await chatArea.waitFor({ timeout: 10_000 })

    await expect(page.locator('[data-test="encryption-required-banner"]')).toBeVisible({
      timeout: 10_000,
    })
  })

  // ── Encryption toggle state on already-encrypted channel ──────────

  test('owner sees encryption toggle as checked and disabled for already-encrypted channel', async ({
    page,
  }) => {
    // WHY: channels-tab.tsx:157 — isDisabled={isEncrypted || isEnabling}. Once encrypted,
    // the toggle stays checked and disabled (one-way). On web it uses the disabled variant.
    await authenticatePage(page, owner)
    await selectServer(page, server.id)

    await page.locator('[data-test="server-header-button"]').click()
    await page.locator('[data-test="server-menu-settings-item"]').click()
    await page.locator('[data-test="server-settings"]').waitFor({ timeout: 10_000 })
    await page.locator('[data-test="settings-tab-channels"]').click()

    const channelList = page.locator('[data-test="settings-channel-list"]')
    await channelList.waitFor({ timeout: 10_000 })

    const encRow = channelList.locator(
      `[data-test="settings-channel-row"][data-channel-id="${encryptedChannel.id}"]`,
    )
    await encRow.waitFor({ timeout: 10_000 })

    // WHY: On web, the disabled toggle variant is rendered for owner.
    // It should be checked (isSelected=true) and disabled.
    const disabledToggle = encRow.locator('[data-test="channel-encryption-toggle-disabled"]')
    await expect(disabledToggle).toBeVisible()

    // Verify it reflects the encrypted state (input checked)
    const switchInput = disabledToggle.locator('input[type="checkbox"]')
    await expect(switchInput).toBeChecked()
    await expect(switchInput).toBeDisabled()
  })

  // ── Verify encryption is persisted via API ────────────────────────

  test('API returns encrypted=true for the encrypted channel', async () => {
    // WHY: Verifies data persistence, not just UI visibility.
    const channels = await getServerChannels(owner.token, server.id)

    const enc = channels.items.find((c) => c.id === encryptedChannel.id)
    expect(enc).toBeDefined()
    expect(enc?.encrypted).toBe(true)

    const plain = channels.items.find((c) => c.id === plainChannel.id)
    expect(plain).toBeDefined()
    expect(plain?.encrypted).toBe(false)
  })
})
