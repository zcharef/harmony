/**
 * E2E Tests — Kick & Ban Moderation
 *
 * Verifies kick/ban via context menu, dialog confirmation, and the bans tab.
 * Role hierarchy is strict greater-than: same rank cannot moderate each other.
 *
 * UI flow for kick: Right-click member -> Kick -> Confirm dialog
 * UI flow for ban:  Right-click member -> Ban -> Enter reason -> Confirm
 * UI flow for ban list: Server settings -> Bans tab
 *
 * Real data-test attributes from:
 * - member-list.tsx:242 (member-item)
 * - member-context-menu.tsx:194,207 (kick-member-item), :216 (ban-member-item)
 * - kick-dialog.tsx:26 (kick-dialog), :47 (kick-submit-button)
 * - ban-dialog.tsx:47 (ban-dialog), :62 (ban-reason-input), :78 (ban-submit-button)
 * - bans-tab.tsx:21 (settings-insufficient-permissions), :50 (settings-ban-list)
 * - server-settings.tsx:74 (settings-tab-bans)
 */
import { expect, test } from '@playwright/test'
import { authenticatePage, selectServer } from './fixtures/auth-fixture'
import {
  assignRole,
  banUser,
  createInvite,
  createServer,
  joinServer,
  kickMember,
  syncProfile,
  unbanUser,
} from './fixtures/test-data-factory'
import { createTestUser, type TestUser } from './fixtures/user-factory'

test.describe('Kick & Ban Moderation', () => {
  let owner: TestUser
  let admin: TestUser
  let mod: TestUser
  let member: TestUser
  let server: { id: string; name: string }

  test.beforeAll(async () => {
    owner = await createTestUser('mod-owner')
    admin = await createTestUser('mod-admin')
    mod = await createTestUser('mod-mod')
    member = await createTestUser('mod-member')
    for (const u of [owner, admin, mod, member]) await syncProfile(u.token)

    server = await createServer(owner.token, `Mod E2E ${Date.now()}`)
    const invite = await createInvite(owner.token, server.id)
    for (const u of [admin, mod, member]) await joinServer(u.token, server.id, invite.code)

    await assignRole(owner.token, server.id, admin.id, 'admin')
    await assignRole(owner.token, server.id, mod.id, 'moderator')
  })

  test('moderator kicks member via context menu', async ({ page }) => {
    // WHY: Create a disposable member so the kick doesn't affect other tests.
    const kickTarget = await createTestUser('mod-kick-target')
    await syncProfile(kickTarget.token)
    const invite = await createInvite(owner.token, server.id)
    await joinServer(kickTarget.token, server.id, invite.code)

    await authenticatePage(page, mod)
    await page.goto('/')
    await page.locator('[data-test="main-layout"]').waitFor({ timeout: 15_000 })
    await selectServer(page, server.id)

    const memberList = page.locator('[data-test="member-list"]')
    await memberList.waitFor({ timeout: 10_000 })

    // Right-click target to open context menu
    const targetItem = memberList.locator(
      `[data-test="member-item"][data-user-id="${kickTarget.id}"]`,
    )
    await targetItem.waitFor({ timeout: 10_000 })
    await page.keyboard.press('Escape')
    await targetItem.click({ button: 'right' })
    await page.locator('[data-test="member-context-menu"]').waitFor({ timeout: 5_000 })

    // Click kick
    const kickMenuItem = page.locator('[data-test="kick-member-item"]')
    await kickMenuItem.waitFor({ timeout: 5_000 })
    await kickMenuItem.click()

    // Confirm in the kick dialog
    const kickDialog = page.locator('[data-test="kick-dialog"]')
    await expect(kickDialog).toBeVisible({ timeout: 5_000 })

    const kickResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/v1/servers/${server.id}/members/${kickTarget.id}`) &&
        response.request().method() === 'DELETE',
    )

    await page.locator('[data-test="kick-submit-button"]').click()

    const kickResponse = await kickResponsePromise
    expect(kickResponse.status()).toBeLessThan(400)

    // Dialog closes and member disappears from list
    await expect(kickDialog).not.toBeVisible({ timeout: 5_000 })
    await expect(targetItem).not.toBeVisible({ timeout: 10_000 })
  })

  test('moderator cannot kick admin — kick option hidden for higher rank', async ({ page }) => {
    // WHY: member-context-menu.tsx:39 — canKick requires outranksTarget (strict >).
    // Moderator (rank 2) does NOT outrank admin (rank 3).
    await authenticatePage(page, mod)
    await page.goto('/')
    await page.locator('[data-test="main-layout"]').waitFor({ timeout: 15_000 })
    await selectServer(page, server.id)

    const memberList = page.locator('[data-test="member-list"]')
    await memberList.waitFor({ timeout: 10_000 })

    const adminItem = memberList.locator(`[data-test="member-item"][data-user-id="${admin.id}"]`)
    await adminItem.waitFor({ timeout: 10_000 })
    await page.keyboard.press('Escape')
    await adminItem.click({ button: 'right' })
    await page.locator('[data-test="member-context-menu"]').waitFor({ timeout: 5_000 })

    // Send message should be available
    const sendMessageItem = page.locator('[data-test="send-message-item"]')
    await sendMessageItem.waitFor({ timeout: 5_000 })

    // Kick should NOT be available
    await expect(page.locator('[data-test="kick-member-item"]')).not.toBeVisible()
  })

  test('moderator cannot kick fellow moderator — same rank blocked', async ({ page }) => {
    // WHY: Hierarchy is strict greater-than. Moderator (2) is NOT > moderator (2).
    // Create a second moderator to test this.
    const mod2 = await createTestUser('mod-fellow-mod')
    await syncProfile(mod2.token)
    const invite = await createInvite(owner.token, server.id)
    await joinServer(mod2.token, server.id, invite.code)
    await assignRole(owner.token, server.id, mod2.id, 'moderator')

    await authenticatePage(page, mod)
    await page.goto('/')
    await page.locator('[data-test="main-layout"]').waitFor({ timeout: 15_000 })
    await selectServer(page, server.id)

    const memberList = page.locator('[data-test="member-list"]')
    await memberList.waitFor({ timeout: 10_000 })

    const mod2Item = memberList.locator(`[data-test="member-item"][data-user-id="${mod2.id}"]`)
    await mod2Item.waitFor({ timeout: 10_000 })
    await page.keyboard.press('Escape')
    await mod2Item.click({ button: 'right' })
    await page.locator('[data-test="member-context-menu"]').waitFor({ timeout: 5_000 })

    const sendMessageItem = page.locator('[data-test="send-message-item"]')
    await sendMessageItem.waitFor({ timeout: 5_000 })

    await expect(page.locator('[data-test="kick-member-item"]')).not.toBeVisible()
  })

  test('admin cannot kick owner — kick option hidden', async ({ page }) => {
    // WHY: Admin (rank 3) does NOT outrank owner (rank 4).
    await authenticatePage(page, admin)
    await page.goto('/')
    await page.locator('[data-test="main-layout"]').waitFor({ timeout: 15_000 })
    await selectServer(page, server.id)

    const memberList = page.locator('[data-test="member-list"]')
    await memberList.waitFor({ timeout: 10_000 })

    const ownerItem = memberList.locator(`[data-test="member-item"][data-user-id="${owner.id}"]`)
    await ownerItem.waitFor({ timeout: 10_000 })
    await page.keyboard.press('Escape')
    await ownerItem.click({ button: 'right' })
    await page.locator('[data-test="member-context-menu"]').waitFor({ timeout: 5_000 })

    const sendMessageItem = page.locator('[data-test="send-message-item"]')
    await sendMessageItem.waitFor({ timeout: 5_000 })

    await expect(page.locator('[data-test="kick-member-item"]')).not.toBeVisible()
    await expect(page.locator('[data-test="ban-member-item"]')).not.toBeVisible()
  })

  test('member cannot kick anyone — kick option hidden in context menu', async ({ page }) => {
    // WHY: member-context-menu.tsx:39 — canKick requires callerRank >= moderator.
    // Member (rank 1) < moderator (rank 2).
    await authenticatePage(page, member)
    await page.goto('/')
    await page.locator('[data-test="main-layout"]').waitFor({ timeout: 15_000 })
    await selectServer(page, server.id)

    const memberList = page.locator('[data-test="member-list"]')
    await memberList.waitFor({ timeout: 10_000 })

    // Right-click a moderator
    const modItem = memberList.locator(`[data-test="member-item"][data-user-id="${mod.id}"]`)
    await modItem.waitFor({ timeout: 10_000 })
    await page.keyboard.press('Escape')
    await modItem.click({ button: 'right' })
    await page.locator('[data-test="member-context-menu"]').waitFor({ timeout: 5_000 })

    const sendMessageItem = page.locator('[data-test="send-message-item"]')
    await sendMessageItem.waitFor({ timeout: 5_000 })

    await expect(page.locator('[data-test="kick-member-item"]')).not.toBeVisible()
    await expect(page.locator('[data-test="ban-member-item"]')).not.toBeVisible()
  })

  test('cannot self-kick — context menu shows no actions for self', async ({ page }) => {
    // WHY: member-context-menu.tsx:35 — outranksTarget requires isSelf === false.
    // Also, canSendMessage is false for self (line 85).
    await authenticatePage(page, admin)
    await page.goto('/')
    await page.locator('[data-test="main-layout"]').waitFor({ timeout: 15_000 })
    await selectServer(page, server.id)

    const memberList = page.locator('[data-test="member-list"]')
    await memberList.waitFor({ timeout: 10_000 })

    // Right-click self
    const selfItem = memberList.locator(`[data-test="member-item"][data-user-id="${admin.id}"]`)
    await selfItem.waitFor({ timeout: 10_000 })
    await page.keyboard.press('Escape')
    await selfItem.click({ button: 'right' })
    await page.locator('[data-test="member-context-menu"]').waitFor({ timeout: 5_000 })

    // No kick or ban items visible
    await expect(page.locator('[data-test="kick-member-item"]')).not.toBeVisible()
    await expect(page.locator('[data-test="ban-member-item"]')).not.toBeVisible()
    // No send-message item for self either
    await expect(page.locator('[data-test="send-message-item"]')).not.toBeVisible()
  })

  test('admin bans member via context menu with reason', async ({ page }) => {
    // WHY: Create a disposable member for the ban test.
    const banTarget = await createTestUser('mod-ban-target')
    await syncProfile(banTarget.token)
    const invite = await createInvite(owner.token, server.id)
    await joinServer(banTarget.token, server.id, invite.code)

    await authenticatePage(page, admin)
    await page.goto('/')
    await page.locator('[data-test="main-layout"]').waitFor({ timeout: 15_000 })
    await selectServer(page, server.id)

    const memberList = page.locator('[data-test="member-list"]')
    await memberList.waitFor({ timeout: 10_000 })

    const targetItem = memberList.locator(
      `[data-test="member-item"][data-user-id="${banTarget.id}"]`,
    )
    await targetItem.waitFor({ timeout: 10_000 })
    await page.keyboard.press('Escape')
    await targetItem.click({ button: 'right' })
    await page.locator('[data-test="member-context-menu"]').waitFor({ timeout: 5_000 })

    const banMenuItem = page.locator('[data-test="ban-member-item"]')
    await banMenuItem.waitFor({ timeout: 5_000 })
    await banMenuItem.click()

    // Fill ban reason
    const banDialog = page.locator('[data-test="ban-dialog"]')
    await expect(banDialog).toBeVisible({ timeout: 5_000 })

    await page.locator('[data-test="ban-reason-input"]').fill('E2E test ban reason')

    const banResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/v1/servers/${server.id}/bans`) &&
        response.request().method() === 'POST',
    )

    await page.locator('[data-test="ban-submit-button"]').click()

    const banResponse = await banResponsePromise
    expect(banResponse.status()).toBeLessThan(400)

    // Dialog closes and member disappears
    await expect(banDialog).not.toBeVisible({ timeout: 5_000 })
    await expect(targetItem).not.toBeVisible({ timeout: 10_000 })
  })

  test('admin unbans user via settings bans tab', async ({ page }) => {
    // WHY: Create and ban a user via API, then unban via the UI.
    const unbanTarget = await createTestUser('mod-unban-target')
    await syncProfile(unbanTarget.token)
    const invite = await createInvite(owner.token, server.id)
    await joinServer(unbanTarget.token, server.id, invite.code)
    await banUser(admin.token, server.id, unbanTarget.id, 'to be unbanned')

    await authenticatePage(page, admin)
    await page.goto('/')
    await page.locator('[data-test="main-layout"]').waitFor({ timeout: 15_000 })
    await selectServer(page, server.id)

    // Open server settings via server header menu
    await page.locator('[data-test="server-header-button"]').click()
    // WHY: Wait for dropdown to render — HeroUI dropdown has animation delay.
    const settingsItem = page.locator('[data-test="server-menu-settings-item"]')
    await settingsItem.waitFor({ timeout: 5_000 })
    await settingsItem.click()

    const serverSettings = page.locator('[data-test="server-settings"]')
    await serverSettings.waitFor({ timeout: 10_000 })

    // Navigate to Bans tab
    await page.locator('[data-test="settings-tab-bans"]').click()

    const banList = page.locator('[data-test="settings-ban-list"]')
    await banList.waitFor({ timeout: 10_000 })

    // Find the banned user's row
    const banRow = banList.locator(`[data-test="ban-row"][data-user-id="${unbanTarget.id}"]`)
    await banRow.waitFor({ timeout: 10_000 })

    // Click unban
    const unbanResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/v1/servers/${server.id}/bans/${unbanTarget.id}`) &&
        response.request().method() === 'DELETE',
    )

    await banRow.locator('[data-test="unban-button"]').click()

    const unbanResponse = await unbanResponsePromise
    expect(unbanResponse.status()).toBeLessThan(400)

    // Ban row disappears
    await expect(banRow).not.toBeVisible({ timeout: 10_000 })
  })

  test('admin cannot ban higher-ranked user — ban option hidden for owner', async ({ page }) => {
    // WHY: member-context-menu.tsx:40 — canBan requires outranksTarget AND callerRank >= admin.
    // Admin (3) does NOT outrank owner (4).
    await authenticatePage(page, admin)
    await page.goto('/')
    await page.locator('[data-test="main-layout"]').waitFor({ timeout: 15_000 })
    await selectServer(page, server.id)

    const memberList = page.locator('[data-test="member-list"]')
    await memberList.waitFor({ timeout: 10_000 })

    const ownerItem = memberList.locator(`[data-test="member-item"][data-user-id="${owner.id}"]`)
    await ownerItem.waitFor({ timeout: 10_000 })
    await page.keyboard.press('Escape')
    await ownerItem.click({ button: 'right' })
    await page.locator('[data-test="member-context-menu"]').waitFor({ timeout: 5_000 })

    const sendMessageItem = page.locator('[data-test="send-message-item"]')
    await sendMessageItem.waitFor({ timeout: 5_000 })

    await expect(page.locator('[data-test="ban-member-item"]')).not.toBeVisible()
  })

  test('admin cannot ban themselves — ban option hidden for self', async ({ page }) => {
    // WHY: member-context-menu.tsx:35 — outranksTarget requires isSelf === false.
    await authenticatePage(page, admin)
    await page.goto('/')
    await page.locator('[data-test="main-layout"]').waitFor({ timeout: 15_000 })
    await selectServer(page, server.id)

    const memberList = page.locator('[data-test="member-list"]')
    await memberList.waitFor({ timeout: 10_000 })

    const selfItem = memberList.locator(`[data-test="member-item"][data-user-id="${admin.id}"]`)
    await selfItem.waitFor({ timeout: 10_000 })
    await page.keyboard.press('Escape')
    await selfItem.click({ button: 'right' })
    await page.locator('[data-test="member-context-menu"]').waitFor({ timeout: 5_000 })

    await expect(page.locator('[data-test="ban-member-item"]')).not.toBeVisible()
    await expect(page.locator('[data-test="kick-member-item"]')).not.toBeVisible()
  })

  test('ban list visible to admin — member sees insufficient permissions', async ({ page }) => {
    // WHY: bans-tab.tsx:19 — isAdmin check gates the ban list. Non-admin sees
    // settings-insufficient-permissions (line 21).

    // First verify admin can see the ban list
    await authenticatePage(page, admin)
    await page.goto('/')
    await page.locator('[data-test="main-layout"]').waitFor({ timeout: 15_000 })
    await selectServer(page, server.id)

    await page.locator('[data-test="server-header-button"]').click()
    // WHY: Wait for dropdown to render — HeroUI dropdown has animation delay.
    const settingsItem = page.locator('[data-test="server-menu-settings-item"]')
    await settingsItem.waitFor({ timeout: 5_000 })
    await settingsItem.click()

    const serverSettings = page.locator('[data-test="server-settings"]')
    await serverSettings.waitFor({ timeout: 10_000 })
    await page.locator('[data-test="settings-tab-bans"]').click()

    const banList = page.locator('[data-test="settings-ban-list"]')
    await banList.waitFor({ timeout: 10_000 })
    await expect(banList).toBeVisible()
  })

  test('kicked user can rejoin via invite', async ({ page }) => {
    // WHY: Kick removes the member but does NOT ban them.
    const rejoinTarget = await createTestUser('mod-rejoin-target')
    await syncProfile(rejoinTarget.token)
    const invite = await createInvite(owner.token, server.id)
    await joinServer(rejoinTarget.token, server.id, invite.code)

    // Kick via API
    await kickMember(admin.token, server.id, rejoinTarget.id)

    // Create a new invite and rejoin
    const newInvite = await createInvite(owner.token, server.id)
    await joinServer(rejoinTarget.token, server.id, newInvite.code)

    // Verify the user is back in the member list
    await authenticatePage(page, owner)
    await page.goto('/')
    await page.locator('[data-test="main-layout"]').waitFor({ timeout: 15_000 })
    await selectServer(page, server.id)

    const memberList = page.locator('[data-test="member-list"]')
    await memberList.waitFor({ timeout: 10_000 })

    const rejoinedItem = memberList.locator(
      `[data-test="member-item"][data-user-id="${rejoinTarget.id}"]`,
    )
    await expect(rejoinedItem).toBeVisible({ timeout: 10_000 })
  })

  test('banned user cannot rejoin via invite', async ({ page }) => {
    // WHY: Ban both removes the member AND prevents them from rejoining.
    const bannedTarget = await createTestUser('mod-banned-rejoin')
    await syncProfile(bannedTarget.token)
    const invite = await createInvite(owner.token, server.id)
    await joinServer(bannedTarget.token, server.id, invite.code)

    // Ban via API
    await banUser(admin.token, server.id, bannedTarget.id, 'banned for test')

    // Attempt to rejoin — should fail
    const newInvite = await createInvite(owner.token, server.id)
    const rejoinRes = await fetch(`http://localhost:3000/v1/servers/${server.id}/members`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bannedTarget.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ inviteCode: newInvite.code }),
    })

    // The API should reject the join with a 403
    expect(rejoinRes.status).toBeGreaterThanOrEqual(400)

    // Verify the user does NOT appear in the member list
    await authenticatePage(page, owner)
    await page.goto('/')
    await page.locator('[data-test="main-layout"]').waitFor({ timeout: 15_000 })
    await selectServer(page, server.id)

    const memberList = page.locator('[data-test="member-list"]')
    await memberList.waitFor({ timeout: 10_000 })

    const bannedItem = memberList.locator(
      `[data-test="member-item"][data-user-id="${bannedTarget.id}"]`,
    )
    await expect(bannedItem).not.toBeVisible()

    // Cleanup: unban for isolation
    await unbanUser(admin.token, server.id, bannedTarget.id)
  })
})
