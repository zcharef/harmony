/**
 * E2E Tests — Encryption UI Features
 *
 * Verifies that E2EE-related UI elements behave correctly on the web client:
 * - Encryption toggle visibility based on role (owner-only) and platform (disabled on web)
 * - Encrypted channel badge in the sidebar after enabling encryption via API
 * - EncryptionRequiredBanner shown on web for encrypted channels
 * - E2EE alpha banner shown in the toolbar for encrypted channels
 * - Message input disabled on web for encrypted channels
 * - DMs on web: input enabled (plaintext), DmPlaintextBanner shown, per-message lock icons
 * - Encrypted message fallback text on web in DMs
 *
 * WHY web-only scope: The Playwright tests run against the Vite dev server (not Tauri).
 * On web, isTauri() returns false, so the encryption toggle is disabled (desktop-only)
 * and the message input is blocked for encrypted channels. DMs are an exception: web
 * users can send plaintext DMs, with clear indicators distinguishing them from encrypted
 * messages sent by desktop users.
 *
 * Real data-test attributes from:
 * - channels-tab.tsx:160 (channel-encryption-toggle), :175 (channel-encryption-toggle-disabled)
 * - channels-tab.tsx:125 (settings-channel-row), :139 (channel-encrypted-icon)
 * - channel-sidebar.tsx:57 (channel-button), :73 (EncryptedChannelBadge)
 * - encrypted-channel-badge.tsx:21 (encrypted-channel-badge)
 * - encryption-required-banner.tsx:20 (encryption-required-banner)
 * - e2ee-alpha-banner.tsx:17 (e2ee-alpha-banner)
 * - chat-area.tsx:342 (message-input), :820 (chat-area)
 * - encrypted-channel-notice.tsx:41 (encrypted-channel-notice)
 * - dm-plaintext-banner.tsx:18 (dm-plaintext-banner)
 * - message-item.tsx:279 (message-encryption-indicator)
 * - message-item.tsx:182 (encrypted web fallback in message-content)
 */
import { expect, test } from '@playwright/test'
import { authenticatePage, selectChannel, selectServer } from './fixtures/auth-fixture'
import {
  assignRole,
  createChannel,
  createDm,
  createInvite,
  createServer,
  joinServer,
  sendEncryptedMessage,
  sendMessage,
  syncProfile,
  updateChannel,
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
    // WHY: Wait for dropdown to render — HeroUI dropdown has animation delay.
    const settingsItem = page.locator('[data-test="server-menu-settings-item"]')
    await settingsItem.waitFor({ timeout: 10_000 })
    await settingsItem.click()
    await page.locator('[data-test="server-settings"]').waitFor({ timeout: 10_000 })
    await page.locator('[data-test="settings-tab-channels"]').click()

    // Find the plain channel row (not yet encrypted)
    const channelList = page.locator('[data-test="settings-channel-list"]')
    await channelList.waitFor({ timeout: 10_000 })

    const plainRow = channelList.locator(
      `[data-test="settings-channel-row"][data-channel-id="${plainChannel.id}"]`,
    )
    await plainRow.waitFor({ timeout: 10_000 })

    // WHY: Accordion layout — expand the row to reveal ChannelSettingsCard controls.
    await plainRow.click()
    await plainRow.locator('[data-test="channel-settings-card"]').waitFor({ timeout: 10_000 })

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
    // WHY: Wait for dropdown to render — HeroUI dropdown has animation delay.
    const settingsItem = page.locator('[data-test="server-menu-settings-item"]')
    await settingsItem.waitFor({ timeout: 10_000 })
    await settingsItem.click()
    await page.locator('[data-test="server-settings"]').waitFor({ timeout: 10_000 })
    await page.locator('[data-test="settings-tab-channels"]').click()

    const channelList = page.locator('[data-test="settings-channel-list"]')
    await channelList.waitFor({ timeout: 10_000 })

    const plainRow = channelList.locator(
      `[data-test="settings-channel-row"][data-channel-id="${plainChannel.id}"]`,
    )
    await plainRow.waitFor({ timeout: 10_000 })

    // Neither active nor disabled encryption toggle should be visible for admin
    await expect(plainRow.locator('[data-test="channel-encryption-toggle"]')).not.toBeAttached()
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
    // WHY: Wait for dropdown to render — HeroUI dropdown has animation delay.
    const settingsItem = page.locator('[data-test="server-menu-settings-item"]')
    await settingsItem.waitFor({ timeout: 5_000 })
    await settingsItem.click()
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
    // WHY: chat-area.tsx:621 — !isTauri() && isChannelEncrypted renders EncryptionRequiredBanner.
    // WHY: chat-area.tsx:801 — isWebEncryptionBlocked (= !isTauri() && isChannelEncrypted) disables input.
    await authenticatePage(page, owner)
    await selectServer(page, server.id)

    // Select the encrypted channel
    await selectChannel(page, encryptedChannel.name)

    const chatArea = page.locator('[data-test="chat-area"]')
    await chatArea.waitFor({ timeout: 10_000 })

    // EncryptionRequiredBanner should be visible on web with desktop-app messaging
    const encBanner = page.locator('[data-test="encryption-required-banner"]')
    await expect(encBanner).toBeVisible({ timeout: 10_000 })
    await expect(encBanner).toContainText('desktop')

    // Message input should be read-only on web for encrypted channels.
    // WHY: HeroUI Textarea passes data-test directly to the <textarea> element,
    // not a wrapper div — so the selector targets the textarea itself.
    const messageInput = page.locator('[data-test="message-input"]')
    await messageInput.waitFor({ timeout: 10_000 })

    // WHY: The Textarea has isReadOnly={isInputDisabled} when isWebEncryptionBlocked is true.
    // HeroUI renders this as readonly attribute on the underlying textarea element.
    await expect(messageInput).toHaveAttribute('readonly', '')
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

    // Message input should be editable.
    // WHY: HeroUI Textarea passes data-test directly to the <textarea> element.
    const messageInput = page.locator('[data-test="message-input"]')
    await messageInput.waitFor({ timeout: 10_000 })

    await expect(messageInput).not.toHaveAttribute('readonly')
  })

  // ── E2EE alpha banner in toolbar ──────────────────────────────────

  test('encrypted channel shows E2EE alpha banner in toolbar', async ({ page }) => {
    // WHY: chat-area.tsx:289 — isChannelEncrypted renders E2eeAlphaBanner in ChatToolbar.
    await authenticatePage(page, owner)
    await selectServer(page, server.id)

    await selectChannel(page, encryptedChannel.name)

    const toolbar = page.locator('[data-test="chat-toolbar"]')
    await toolbar.waitFor({ timeout: 10_000 })

    const alphaBanner = toolbar.locator('[data-test="e2ee-alpha-banner"]')
    await expect(alphaBanner).toBeVisible()
    await expect(alphaBanner).toContainText('E2EE Alpha')
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

    const encBannerMember = page.locator('[data-test="encryption-required-banner"]')
    await expect(encBannerMember).toBeVisible({ timeout: 10_000 })
    await expect(encBannerMember).toContainText('desktop')
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
    // WHY: Wait for dropdown to render — HeroUI dropdown has animation delay.
    const settingsItem = page.locator('[data-test="server-menu-settings-item"]')
    await settingsItem.waitFor({ timeout: 5_000 })
    await settingsItem.click()
    await page.locator('[data-test="server-settings"]').waitFor({ timeout: 10_000 })
    await page.locator('[data-test="settings-tab-channels"]').click()

    const channelList = page.locator('[data-test="settings-channel-list"]')
    await channelList.waitFor({ timeout: 10_000 })

    const encRow = channelList.locator(
      `[data-test="settings-channel-row"][data-channel-id="${encryptedChannel.id}"]`,
    )
    await encRow.waitFor({ timeout: 10_000 })

    // WHY: Accordion layout — expand the row to reveal ChannelSettingsCard controls.
    await encRow.click()
    await encRow.locator('[data-test="channel-settings-card"]').waitFor({ timeout: 5_000 })

    // WHY: On web, the disabled toggle variant is rendered for owner.
    // It should be checked (isSelected=true) and disabled.
    const disabledToggle = encRow.locator('[data-test="channel-encryption-toggle-disabled"]')
    await expect(disabledToggle).toBeVisible()

    // Verify it reflects the encrypted state (input checked)
    const switchInput = disabledToggle.locator('input[type="checkbox"]')
    await expect(switchInput).toBeChecked()
    await expect(switchInput).toBeDisabled()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// DM Encryption on Web — mixed-encryption model
// ═══════════════════════════════════════════════════════════════════════════
//
// WHY separate describe: DMs follow a different encryption model than channels.
// On web, DMs are ENABLED (plaintext) while encrypted channels are BLOCKED.
// Desktop users send encrypted DMs (Olm); web users send plaintext DMs.
// The UI shows per-message lock indicators so users can distinguish.
//
// Source: chat-area.tsx:801 — isWebEncryptionBlocked = !isTauri() && isChannelEncrypted
// (isDm is NOT included, so DMs are not blocked on web)

test.describe('DM Encryption on Web', () => {
  let dmUserA: TestUser
  let dmUserB: TestUser
  let dmData: { serverId: string; channelId: string }
  let dmMessage: string

  test.beforeAll(async () => {
    dmUserA = await createTestUser('enc-dm-a')
    dmUserB = await createTestUser('enc-dm-b')
    for (const u of [dmUserA, dmUserB]) await syncProfile(u.token)

    // WHY: Both users must share a server so they can DM each other
    // (the DM API requires both users to have profiles).
    const sharedServer = await createServer(dmUserA.token, `Enc DM E2E ${Date.now()}`)
    const invite = await createInvite(dmUserA.token, sharedServer.id)
    await joinServer(dmUserB.token, sharedServer.id, invite.code)

    // Create DM and send a message via API so the conversation has content.
    // WHY: sendMessage via API creates a plaintext message (no Tauri = no encryption),
    // which is the expected state for web DM messages.
    dmData = await createDm(dmUserA.token, dmUserB.id)
    dmMessage = `Plaintext DM from web ${Date.now()}`
    await sendMessage(dmUserA.token, dmData.channelId, dmMessage)
  })

  test('web user can send plaintext DM — input enabled, DmPlaintextBanner visible', async ({
    page,
  }) => {
    // WHY: chat-area.tsx:801 — isWebEncryptionBlocked = !isTauri() && isChannelEncrypted.
    // DMs are NOT channel-encrypted, so the input is NOT blocked on web.
    // chat-area.tsx:629 — !isTauri() && isDm renders DmPlaintextBanner (not EncryptionRequiredBanner).
    await authenticatePage(page, dmUserA)

    // Navigate to DM view
    await page.locator('[data-test="dm-home-button"]').click()
    await page.locator('[data-test="dm-sidebar"]').waitFor({ timeout: 10_000 })

    // Select the DM conversation
    const dmItem = page.locator(
      `[data-test="dm-conversation-item"][data-dm-server-id="${dmData.serverId}"]`,
    )
    await dmItem.waitFor({ timeout: 10_000 })
    await dmItem.click()

    const chatArea = page.locator('[data-test="chat-area"]')
    await chatArea.waitFor({ timeout: 10_000 })

    // Message input should NOT be readonly — web DMs allow plaintext input.
    // WHY: HeroUI Textarea passes data-test directly to the <textarea> element.
    const messageInput = page.locator('[data-test="message-input"]')
    await messageInput.waitFor({ timeout: 10_000 })
    await expect(messageInput).not.toHaveAttribute('readonly')

    // DmPlaintextBanner should be visible (softer informational banner for web DMs).
    // WHY: dm-plaintext-banner.tsx:18 — data-test="dm-plaintext-banner".
    const dmBanner = page.locator('[data-test="dm-plaintext-banner"]')
    await expect(dmBanner).toBeVisible({ timeout: 10_000 })
    await expect(dmBanner).toContainText('not encrypted')

    // EncryptionRequiredBanner should NOT appear — that banner is for encrypted channels only.
    await expect(page.locator('[data-test="encryption-required-banner"]')).not.toBeAttached()

    // Verify the previously sent message is visible in the message list.
    const messageContent = page
      .locator('[data-test="message-content"]')
      .filter({ hasText: dmMessage })
    await expect(messageContent.first()).toBeVisible({ timeout: 10_000 })

    // Type and send a new message from the web client to verify input works end-to-end.
    const newMessage = `Web DM reply ${Date.now()}`
    await messageInput.fill(newMessage)
    await expect(messageInput).toHaveValue(newMessage)

    // WHY: Set up waitForResponse BEFORE triggering the send to avoid a race condition
    // where the response arrives before the listener is attached.
    const responsePromise = page.waitForResponse((response) => response.url().includes('/messages'))
    await messageInput.press('Enter')

    const response = await responsePromise
    expect(response.status()).toBeLessThan(400)

    // Verify the new message appears in the message list.
    const sentContent = page
      .locator('[data-test="message-content"]')
      .filter({ hasText: newMessage })
    await expect(sentContent.first()).toBeVisible({ timeout: 15_000 })
  })

  test('per-message lock icons appear in DM conversation', async ({ page }) => {
    // WHY: message-item.tsx:270-287 — isDm renders a per-message encryption indicator.
    // Lock (filled) = encrypted (from desktop), LockOpen = plaintext (from web).
    // Since our test message was sent via API (no Tauri), it should show LockOpen.
    await authenticatePage(page, dmUserA)

    await page.locator('[data-test="dm-home-button"]').click()
    await page.locator('[data-test="dm-sidebar"]').waitFor({ timeout: 10_000 })

    const dmItem = page.locator(
      `[data-test="dm-conversation-item"][data-dm-server-id="${dmData.serverId}"]`,
    )
    await dmItem.waitFor({ timeout: 10_000 })
    await dmItem.click()

    await page.locator('[data-test="chat-area"]').waitFor({ timeout: 10_000 })

    // Wait for at least one message to render
    const messageItem = page.locator('[data-test="message-item"]')
    await messageItem.first().waitFor({ timeout: 10_000 })

    // Verify encryption indicator exists on messages in the DM.
    // WHY: message-item.tsx:279 — data-test="message-encryption-indicator" renders
    // inside a Tooltip with lock/lock-open icon for every DM message.
    const encryptionIndicator = page.locator('[data-test="message-encryption-indicator"]')
    await expect(encryptionIndicator.first()).toBeVisible({ timeout: 10_000 })

    // WHY: Verify the indicator contains an SVG icon (Lock or LockOpen from Lucide).
    // API-sent messages have encrypted=false, so the LockOpen icon is rendered.
    await expect(encryptionIndicator.first().locator('svg')).toBeAttached()
  })

  test('encrypted message from desktop shows fallback text on web', async ({ page }) => {
    // WHY: message-item.tsx:178-187 — when message.encrypted === true && !isTauri(),
    // the component renders an italicized fallback: "Encrypted message — open in desktop app to read"
    // with a Lock icon, instead of showing raw ciphertext.
    //
    // LIMITATION: This test cannot create a real encrypted message because Playwright
    // runs on web (no Tauri, no vodozemac). To fully test the encrypted fallback render,
    // a desktop→web integration test is needed. Here we verify the structural expectations:
    // 1. Plaintext messages render normally (not as fallback).
    // 2. The fallback text is NOT shown for plaintext messages (no false positives).
    await authenticatePage(page, dmUserA)

    await page.locator('[data-test="dm-home-button"]').click()
    await page.locator('[data-test="dm-sidebar"]').waitFor({ timeout: 10_000 })

    const dmItem = page.locator(
      `[data-test="dm-conversation-item"][data-dm-server-id="${dmData.serverId}"]`,
    )
    await dmItem.waitFor({ timeout: 10_000 })
    await dmItem.click()

    await page.locator('[data-test="chat-area"]').waitFor({ timeout: 10_000 })

    // Verify our plaintext message renders as normal text (not the encrypted fallback).
    const messageContent = page
      .locator('[data-test="message-content"]')
      .filter({ hasText: dmMessage })
    await expect(messageContent.first()).toBeVisible({ timeout: 10_000 })

    // The encrypted fallback text should NOT appear for plaintext messages.
    // WHY: "Encrypted message" fallback (crypto.json:encryptedWebFallback) only renders
    // when message.encrypted === true && !isTauri(). Our API-sent messages have encrypted=false.
    const fallbackText = page
      .locator('[data-test="message-content"]')
      .filter({ hasText: 'Encrypted message' })
    // WHY: Use count() === 0 instead of not.toBeAttached() because there could be
    // multiple message-content elements and we need to verify NONE contain fallback text.
    const fallbackCount = await fallbackText.count()
    expect(fallbackCount).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Cross-Platform DM Encryption — encrypted vs plaintext messages in same DM
// ═══════════════════════════════════════════════════════════════════════════
//
// WHY separate describe: The DM Encryption on Web block above tests pure-plaintext DMs.
// This block tests a MIXED conversation (encrypted from desktop + plaintext from web)
// which is the real cross-platform scenario. It verifies the API bug fix that dropped
// the `encrypted` flag, and that the web UI correctly distinguishes message types.
//
// Source: message-item.tsx:178-187 — encrypted === true && !isTauri() renders fallback
// Source: message-item.tsx:279 — data-test="message-encryption-indicator"

test.describe('Cross-Platform DM Encryption', () => {
  let sender: TestUser
  let receiver: TestUser
  let dmData: { serverId: string; channelId: string }
  let encryptedMsgA: string
  let plaintextMsgB: string
  let encryptedMsgC: string

  test.beforeAll(async () => {
    sender = await createTestUser('xplat-dm-sender')
    receiver = await createTestUser('xplat-dm-receiver')
    for (const u of [sender, receiver]) await syncProfile(u.token)

    // WHY: Both users must share a server so they can DM each other.
    const sharedServer = await createServer(sender.token, `XPlat DM E2E ${Date.now()}`)
    const invite = await createInvite(sender.token, sharedServer.id)
    await joinServer(receiver.token, sharedServer.id, invite.code)

    dmData = await createDm(sender.token, receiver.id)

    // WHY: DM channels are created as plaintext by default. Encrypted messages
    // are rejected on non-encrypted channels (message_service.rs:126). Enable
    // encryption before sending encrypted messages.
    await updateChannel(sender.token, dmData.serverId, dmData.channelId, { encrypted: true })

    // Message A: encrypted DM — simulates desktop sender
    encryptedMsgA = `encrypted-desktop-A-${Date.now()}`
    await sendEncryptedMessage(sender.token, dmData.channelId, encryptedMsgA, 'desktop-device-1')

    // Message B: plaintext DM — simulates web sender
    plaintextMsgB = `plaintext-web-B-${Date.now()}`
    await sendMessage(sender.token, dmData.channelId, plaintextMsgB)

    // Message C: encrypted DM — simulates desktop sender
    encryptedMsgC = `encrypted-desktop-C-${Date.now()}`
    await sendEncryptedMessage(sender.token, dmData.channelId, encryptedMsgC, 'desktop-device-2')
  })

  test('mixed DM shows fallback for encrypted and content for plaintext', async ({ page }) => {
    // WHY: Core cross-platform scenario — verifies BOTH encrypted fallback AND plaintext
    // rendering in a single conversation. Catches the API bug that dropped encrypted=true.
    await authenticatePage(page, receiver)

    await page.locator('[data-test="dm-home-button"]').click()
    await page.locator('[data-test="dm-sidebar"]').waitFor({ timeout: 10_000 })

    const dmItem = page.locator(
      `[data-test="dm-conversation-item"][data-dm-server-id="${dmData.serverId}"]`,
    )
    await dmItem.waitFor({ timeout: 10_000 })
    await dmItem.click()

    await page.locator('[data-test="chat-area"]').waitFor({ timeout: 10_000 })

    // Wait for messages to render
    const messageItems = page.locator('[data-test="message-item"]')
    await messageItems.first().waitFor({ timeout: 10_000 })

    // Encrypted messages (A and C) should show the fallback text, not raw ciphertext.
    // WHY: The i18n key crypto.encryptedWebFallback renders as "Encrypted message".
    const fallbackMessages = page
      .locator('[data-test="message-content"]')
      .filter({ hasText: 'Encrypted message' })
    await expect(fallbackMessages.first()).toBeVisible({ timeout: 10_000 })

    // At least 2 encrypted messages (A and C) should show fallback
    const fallbackCount = await fallbackMessages.count()
    expect(fallbackCount).toBeGreaterThanOrEqual(2)

    // Plaintext message B should show its actual content (not fallback).
    const plaintextContent = page
      .locator('[data-test="message-content"]')
      .filter({ hasText: plaintextMsgB })
    await expect(plaintextContent.first()).toBeVisible({ timeout: 10_000 })

    // WHY: Encryption indicators are only rendered in message headers, which are
    // hidden for grouped messages (same author in sequence). Since all 3 test
    // messages come from the same sender, only the first message in the group
    // shows its header. We verify at least 1 indicator exists.
    const encryptionIndicators = page.locator('[data-test="message-encryption-indicator"]')
    const indicatorCount = await encryptionIndicators.count()
    expect(indicatorCount).toBeGreaterThanOrEqual(1)
  })
})
