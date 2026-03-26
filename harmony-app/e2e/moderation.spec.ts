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
 * - member-context-menu.tsx:214 (kick-member-item), :225 (ban-member-item)
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

/** WHY: Helper to open context menu for a member by user ID.
 * Encapsulates the wait-for-member-list -> find-item -> right-click -> wait-for-menu
 * sequence that every context-menu test repeats. Eliminates duplication and ensures
 * consistent timeouts across all tests. */
async function openMemberContextMenu(
  page: import('@playwright/test').Page,
  userId: string,
): Promise<void> {
  const memberList = page.locator('[data-test="member-list"]')
  await memberList.waitFor({ timeout: 15_000 })

  const item = memberList.locator(`[data-test="member-item"][data-user-id="${userId}"]`)
  await item.waitFor({ timeout: 10_000 })

  // WHY: Dismiss any lingering popover/dropdown that could intercept the right-click.
  await page.keyboard.press('Escape')

  await item.click({ button: 'right' })

  const menu = page.locator('[data-test="member-context-menu"]')
  await menu.waitFor({ timeout: 5_000 })

  // WHY: HeroUI Dropdown uses CSS transition (~150ms) for entry animation.
  // The menu wrapper appears immediately but inner items are still transitioning
  // (position/opacity), causing Playwright's "element is not stable" error on click.
  // Waiting for the first visible menu item (identified by data-test) to pass
  // Playwright's visibility check guarantees the animation is done.
  // WHY: Include no-actions-item for self-menu (shows "No actions available" instead of action items).
  await menu.locator('[data-test="send-message-item"], [data-test="kick-member-item"], [data-test="ban-member-item"], [data-test="no-actions-item"]').first().waitFor({ timeout: 5_000 })
}

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

    // WHY: authenticatePage already navigates to '/' and waits for main-layout.
    // No need for a second page.goto('/') — it wastes time and resets query cache.
    await authenticatePage(page, mod)
    await selectServer(page, server.id)

    await openMemberContextMenu(page, kickTarget.id)

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
    expect(kickResponse.status()).toBe(204)

    // Dialog closes and member disappears from list
    await expect(kickDialog).not.toBeVisible({ timeout: 5_000 })
    await expect(
      page.locator(`[data-test="member-item"][data-user-id="${kickTarget.id}"]`),
    ).not.toBeVisible({ timeout: 10_000 })
  })

  test('moderator cannot kick admin — kick option hidden for higher rank', async ({ page }) => {
    // WHY: member-context-menu.tsx:39 — canKick requires outranksTarget (strict >).
    // Moderator (rank 2) does NOT outrank admin (rank 3).
    await authenticatePage(page, mod)
    await selectServer(page, server.id)

    await openMemberContextMenu(page, admin.id)

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
    await selectServer(page, server.id)

    await openMemberContextMenu(page, mod2.id)

    const sendMessageItem = page.locator('[data-test="send-message-item"]')
    await sendMessageItem.waitFor({ timeout: 5_000 })

    await expect(page.locator('[data-test="kick-member-item"]')).not.toBeVisible()
  })

  test('admin cannot kick owner — kick option hidden', async ({ page }) => {
    // WHY: Admin (rank 3) does NOT outrank owner (rank 4).
    await authenticatePage(page, admin)
    await selectServer(page, server.id)

    await openMemberContextMenu(page, owner.id)

    const sendMessageItem = page.locator('[data-test="send-message-item"]')
    await sendMessageItem.waitFor({ timeout: 5_000 })

    await expect(page.locator('[data-test="kick-member-item"]')).not.toBeVisible()
    await expect(page.locator('[data-test="ban-member-item"]')).not.toBeVisible()
  })

  test('member cannot kick anyone — kick option hidden in context menu', async ({ page }) => {
    // WHY: member-context-menu.tsx:39 — canKick requires callerRank >= moderator.
    // Member (rank 1) < moderator (rank 2).
    await authenticatePage(page, member)
    await selectServer(page, server.id)

    // Right-click a moderator
    await openMemberContextMenu(page, mod.id)

    const sendMessageItem = page.locator('[data-test="send-message-item"]')
    await sendMessageItem.waitFor({ timeout: 5_000 })

    await expect(page.locator('[data-test="kick-member-item"]')).not.toBeVisible()
    await expect(page.locator('[data-test="ban-member-item"]')).not.toBeVisible()
  })

  test('cannot self-kick — context menu shows no actions for self', async ({ page }) => {
    // WHY: member-context-menu.tsx:35 — outranksTarget requires isSelf === false.
    // Also, canSendMessage is false for self (line 85).
    await authenticatePage(page, admin)
    await selectServer(page, server.id)

    // Right-click self
    await openMemberContextMenu(page, admin.id)

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
    await selectServer(page, server.id)

    await openMemberContextMenu(page, banTarget.id)

    const banMenuItem = page.locator('[data-test="ban-member-item"]')
    await banMenuItem.waitFor({ timeout: 5_000 })
    await banMenuItem.click()

    // Fill ban reason
    const banDialog = page.locator('[data-test="ban-dialog"]')
    await expect(banDialog).toBeVisible({ timeout: 5_000 })

    const banReasonInput = page.locator('[data-test="ban-reason-input"]')
    await banReasonInput.fill('E2E test ban reason')
    await expect(banReasonInput).toHaveValue('E2E test ban reason')

    const banResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/v1/servers/${server.id}/bans`) &&
        response.request().method() === 'POST',
    )

    await page.locator('[data-test="ban-submit-button"]').click()

    const banResponse = await banResponsePromise
    expect(banResponse.status()).toBe(201)

    // Dialog closes and member disappears
    await expect(banDialog).not.toBeVisible({ timeout: 5_000 })
    await expect(
      page.locator(`[data-test="member-item"][data-user-id="${banTarget.id}"]`),
    ).not.toBeVisible({ timeout: 10_000 })
  })

  test('admin unbans user via settings bans tab', async ({ page }) => {
    // WHY: Create and ban a user via API, then unban via the UI.
    const unbanTarget = await createTestUser('mod-unban-target')
    await syncProfile(unbanTarget.token)
    const invite = await createInvite(owner.token, server.id)
    await joinServer(unbanTarget.token, server.id, invite.code)
    await banUser(admin.token, server.id, unbanTarget.id, 'to be unbanned')

    await authenticatePage(page, admin)
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
    expect(unbanResponse.status()).toBe(204)

    // Ban row disappears
    await expect(banRow).not.toBeVisible({ timeout: 10_000 })
  })

  test('admin cannot ban higher-ranked user — ban option hidden for owner', async ({ page }) => {
    // WHY: member-context-menu.tsx:40 — canBan requires outranksTarget AND callerRank >= admin.
    // Admin (3) does NOT outrank owner (4).
    await authenticatePage(page, admin)
    await selectServer(page, server.id)

    await openMemberContextMenu(page, owner.id)

    const sendMessageItem = page.locator('[data-test="send-message-item"]')
    await sendMessageItem.waitFor({ timeout: 5_000 })

    await expect(page.locator('[data-test="ban-member-item"]')).not.toBeVisible()
  })

  test('admin cannot ban themselves — ban option hidden for self', async ({ page }) => {
    // WHY: member-context-menu.tsx:35 — outranksTarget requires isSelf === false.
    await authenticatePage(page, admin)
    await selectServer(page, server.id)

    await openMemberContextMenu(page, admin.id)

    await expect(page.locator('[data-test="ban-member-item"]')).not.toBeVisible()
    await expect(page.locator('[data-test="kick-member-item"]')).not.toBeVisible()
  })

  test('ban list visible to admin', async ({ page }) => {
    // WHY: bans-tab.tsx:19 — isAdmin check gates the ban list.

    // WHY: Create a ban via API so the ban list has content regardless of whether
    // earlier tests succeeded. An empty ban-list div has 0 height and is invisible.
    const banListTarget = await createTestUser('mod-banlist-target')
    await syncProfile(banListTarget.token)
    const invite = await createInvite(owner.token, server.id)
    await joinServer(banListTarget.token, server.id, invite.code)
    await banUser(admin.token, server.id, banListTarget.id, 'ban list test')

    // Verify admin can see the ban list
    await authenticatePage(page, admin)
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

  test('member cannot access server settings — settings item hidden', async ({ page }) => {
    // WHY: channel-sidebar.tsx:228 — canAccessSettings requires admin+ (rank >= 3).
    // Member (rank 1) and moderator (rank 2) both fail this check,
    // so the settings menu item is rendered with className="hidden".
    await authenticatePage(page, member)
    await selectServer(page, server.id)

    await page.locator('[data-test="server-header-button"]').click()

    // WHY: The dropdown renders the settings item with display:none for non-admin.
    // Playwright's not.toBeVisible() passes for both hidden and absent elements.
    await expect(page.locator('[data-test="server-menu-settings-item"]')).not.toBeVisible()
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
    await selectServer(page, server.id)

    const memberList = page.locator('[data-test="member-list"]')
    await memberList.waitFor({ timeout: 15_000 })

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

    // WHY: invite_service.rs:180 — is_banned check returns DomainError::Forbidden → 403.
    expect(rejoinRes.status).toBe(403)

    // Verify the user does NOT appear in the member list
    await authenticatePage(page, owner)
    await selectServer(page, server.id)

    const memberList = page.locator('[data-test="member-list"]')
    await memberList.waitFor({ timeout: 15_000 })

    const bannedItem = memberList.locator(
      `[data-test="member-item"][data-user-id="${bannedTarget.id}"]`,
    )
    await expect(bannedItem).not.toBeVisible()

    // Cleanup: unban for isolation
    await unbanUser(admin.token, server.id, bannedTarget.id)
  })
})
