/**
 * E2E Tests — Server Settings Role Gating
 *
 * Verifies that server settings are accessible only to admin+ users, and that
 * each tab (Overview, Roles, Channels, Bans) respects role-based visibility.
 *
 * UI flow: Click server header -> Server Settings menu item -> settings panel
 *
 * Real data-test attributes from:
 * - channel-sidebar.tsx:175 (server-menu-settings-item), :146 (server-name-header)
 * - server-settings.tsx:56 (server-settings), :74 (settings-tab-{key}), :95 (close-settings-button)
 * - overview-tab.tsx:113 (settings-server-name-input), :122 (settings-save-overview-button)
 * - overview-tab.tsx:61 (delete-server-confirm-input), :69 (delete-server-button)
 * - channels-tab.tsx:134 (settings-create-channel-button), :141 (settings-channel-list)
 * - channels-tab.tsx:45 (settings-channel-row), :66 (channel-private-toggle)
 * - channels-tab.tsx:86 (channel-delete-button)
 * - bans-tab.tsx:21 (settings-insufficient-permissions), :50 (settings-ban-list)
 * - roles-tab.tsx:89 (roles-member-row), :111 (role-select), :276 (settings-role-list)
 * - roles-tab.tsx:260 (transfer-ownership-button)
 */
import { expect, type Page, test } from '@playwright/test'
import { authenticatePage, selectServer } from './fixtures/auth-fixture'
import {
  assignRole,
  banUser,
  createChannel,
  createInvite,
  createServer,
  joinServer,
  syncProfile,
  updateServer,
} from './fixtures/test-data-factory'
import { createTestUser, type TestUser } from './fixtures/user-factory'

/**
 * Navigates to a server and waits for the members API to resolve before returning.
 *
 * WHY: useMyMemberRole defaults to 'member' while the members API call is in-flight.
 * The server-menu-settings-item gets className="hidden" until the role resolves.
 * We register the response listener BEFORE selectServer triggers the members fetch,
 * so the response is never missed.
 */
async function navigateToServer(page: Page, serverId: string): Promise<void> {
  await selectServer(page, serverId)
  // WHY: Wait for members to load so useMyMemberRole resolves the correct role.
  // Previously used waitForResponse, but TanStack Query cache can satisfy the
  // query without a new network request — causing the response listener to miss.
  await page.locator('[data-test="member-list"]').waitFor({ timeout: 15_000 })
}

/**
 * Opens the server settings panel for an admin+ user.
 * WHY: Extracted to reduce duplication — every settings test repeats this 5-step flow.
 */
async function openServerSettings(page: Page, _serverId: string): Promise<void> {
  await page.locator('[data-test="server-header-button"]').click()
  // WHY: Wait for dropdown to render — HeroUI dropdown has animation delay.
  const settingsItem = page.locator('[data-test="server-menu-settings-item"]')
  await settingsItem.waitFor({ timeout: 10_000 })
  // WHY: force:true bypasses the actionability "stable" check. HeroUI dropdown items
  // animate on open and can fail the stability check before the animation completes,
  // causing the click to time out while the dropdown eventually closes on its own.
  await settingsItem.click({ force: true })
  await page.locator('[data-test="server-settings"]').waitFor({ timeout: 10_000 })
}

test.describe('Server Settings Role Gating', () => {
  let owner: TestUser
  let admin: TestUser
  let mod: TestUser
  let member: TestUser
  let server: { id: string; name: string }
  test.beforeAll(async () => {
    owner = await createTestUser('set-owner')
    admin = await createTestUser('set-admin')
    mod = await createTestUser('set-mod')
    member = await createTestUser('set-member')
    for (const u of [owner, admin, mod, member]) await syncProfile(u.token)

    server = await createServer(owner.token, `Settings E2E ${Date.now()}`)
    await createChannel(owner.token, server.id, 'test-channel')

    const invite = await createInvite(owner.token, server.id)
    for (const u of [admin, mod, member]) await joinServer(u.token, server.id, invite.code)

    await assignRole(owner.token, server.id, admin.id, 'admin')
    await assignRole(owner.token, server.id, mod.id, 'moderator')

    // Ban a user so the bans tab has data
    const banTarget = await createTestUser('set-ban-target')
    await syncProfile(banTarget.token)
    const invite2 = await createInvite(owner.token, server.id)
    await joinServer(banTarget.token, server.id, invite2.code)
    await banUser(owner.token, server.id, banTarget.id, 'settings test')
  })

  test('owner can open server settings and see all tabs', async ({ page }) => {
    await authenticatePage(page, owner)
    await navigateToServer(page, server.id)

    await openServerSettings(page, server.id)

    // Verify all 4 tabs are visible
    await expect(page.locator('[data-test="settings-tab-overview"]')).toBeVisible()
    await expect(page.locator('[data-test="settings-tab-roles"]')).toBeVisible()
    await expect(page.locator('[data-test="settings-tab-channels"]')).toBeVisible()
    await expect(page.locator('[data-test="settings-tab-bans"]')).toBeVisible()

    // Close button visible
    await expect(page.locator('[data-test="close-settings-button"]')).toBeVisible()
  })

  test('admin can open server settings and see all tabs', async ({ page }) => {
    await authenticatePage(page, admin)
    await navigateToServer(page, server.id)

    await openServerSettings(page, server.id)

    await expect(page.locator('[data-test="settings-tab-overview"]')).toBeVisible()
    await expect(page.locator('[data-test="settings-tab-roles"]')).toBeVisible()
    await expect(page.locator('[data-test="settings-tab-channels"]')).toBeVisible()
    await expect(page.locator('[data-test="settings-tab-bans"]')).toBeVisible()
  })

  test('member cannot access settings — settings menu item hidden', async ({ page }) => {
    // WHY: channel-sidebar.tsx:220 — canAccessSettings = callerRank >= admin.
    // Member (rank 1) < admin (rank 3), so server-menu-settings-item has class "hidden".
    // Also, server-settings.tsx:36-38 auto-closes if non-admin.
    await authenticatePage(page, member)
    // WHY: navigateToServer waits for the members API response so the hidden class
    // reflects the real role (member), not just the default loading state.
    await navigateToServer(page, server.id)

    // Open server header menu
    await page.locator('[data-test="server-header-button"]').click()

    // WHY: The settings item exists in DOM but has class "hidden" for non-admin users.
    // Verify it is not visible.
    const settingsItem = page.locator('[data-test="server-menu-settings-item"]')
    await expect(settingsItem).toBeHidden()
  })

  test('overview tab — admin can edit server name', async ({ page }) => {
    await authenticatePage(page, admin)
    await navigateToServer(page, server.id)

    await openServerSettings(page, server.id)

    // Overview tab is the default tab
    const nameInput = page.locator('[data-test="settings-server-name-input"]')
    await nameInput.waitFor({ timeout: 10_000 })

    // Verify the input is editable (not read-only)
    await expect(nameInput).toBeEditable()

    // Verify save button is visible
    const saveButton = page.locator('[data-test="settings-save-overview-button"]')
    await expect(saveButton).toBeVisible()

    // Edit the name, save, and verify API call succeeds
    const newName = `${server.name} Edited`
    await nameInput.clear()
    await nameInput.fill(newName)
    await expect(nameInput).toHaveValue(newName)

    const updateResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/v1/servers/${server.id}`) &&
        response.request().method() === 'PATCH',
    )

    await saveButton.click()

    const updateResponse = await updateResponsePromise
    expect(updateResponse.status()).toBeLessThan(400)

    // WHY: Restore is done via API to avoid fighting the cache invalidation remount cycle.
    // The PATCH triggers queryClient.invalidateQueries which remounts the form, creating
    // a race between the test filling the input and the form reinitializing with new defaultValues.
    await updateServer(admin.token, server.id, { name: server.name })
  })

  test('channels tab — admin sees create and manage controls', async ({ page }) => {
    await authenticatePage(page, admin)
    await navigateToServer(page, server.id)

    await openServerSettings(page, server.id)

    // Navigate to Channels tab
    await page.locator('[data-test="settings-tab-channels"]').click()

    // Verify create channel button is visible for admin
    const createChannelButton = page.locator('[data-test="settings-create-channel-button"]')
    await createChannelButton.waitFor({ timeout: 10_000 })
    await expect(createChannelButton).toBeVisible()

    // Verify channel list renders
    const channelList = page.locator('[data-test="settings-channel-list"]')
    await channelList.waitFor({ timeout: 10_000 })

    // Verify channel rows show management controls (private toggle, delete button)
    const channelRow = channelList.locator('[data-test="settings-channel-row"]').first()
    await channelRow.waitFor({ timeout: 10_000 })

    // WHY: Channels tab uses accordion layout — controls are inside ChannelSettingsCard
    // which only renders when the row is expanded. Click to expand first.
    await channelRow.click()
    await channelRow.locator('[data-test="channel-settings-card"]').waitFor({ timeout: 10_000 })

    await expect(channelRow.locator('[data-test="channel-private-toggle"]')).toBeVisible()
    await expect(channelRow.locator('[data-test="channel-readonly-toggle"]')).toBeVisible()
    await expect(channelRow.locator('[data-test="channel-delete-button"]')).toBeVisible()
  })

  test('bans tab — admin sees ban list', async ({ page }) => {
    await authenticatePage(page, admin)
    await navigateToServer(page, server.id)

    await openServerSettings(page, server.id)

    await page.locator('[data-test="settings-tab-bans"]').click()

    // Ban list should be visible with at least one ban (from beforeAll)
    const banList = page.locator('[data-test="settings-ban-list"]')
    await banList.waitFor({ timeout: 10_000 })
    await expect(banList).toBeVisible()

    const banRows = banList.locator('[data-test="ban-row"]')
    const count = await banRows.count()
    expect(count).toBeGreaterThanOrEqual(1)

    // Unban button visible on each ban row
    await expect(banRows.first().locator('[data-test="unban-button"]')).toBeVisible()
  })

  test('roles tab — admin can manage roles via select dropdown', async ({ page }) => {
    await authenticatePage(page, admin)
    await navigateToServer(page, server.id)

    await openServerSettings(page, server.id)

    await page.locator('[data-test="settings-tab-roles"]').click()

    // Verify the roles member list loads
    const roleList = page.locator('[data-test="settings-role-list"]')
    await roleList.waitFor({ timeout: 10_000 })

    // Verify member rows are present
    const memberRows = roleList.locator('[data-test="roles-member-row"]')
    const count = await memberRows.count()
    expect(count).toBeGreaterThanOrEqual(3)

    // Verify admin can see role-select dropdowns for members they outrank
    // WHY: roles-tab.tsx:103 — canChangeRole requires !isSelf AND callerRank > targetRank.
    // Admin (3) > member (1), so a role-select should appear for regular members.
    const memberRow = roleList.locator(
      `[data-test="roles-member-row"][data-user-id="${member.id}"]`,
    )
    await memberRow.waitFor({ timeout: 10_000 })
    await expect(memberRow.locator('[data-test="role-select"]')).toBeVisible()

    // Admin should NOT have a role-select for the owner (can't change higher rank)
    const ownerRow = roleList.locator(`[data-test="roles-member-row"][data-user-id="${owner.id}"]`)
    await ownerRow.waitFor({ timeout: 10_000 })
    await expect(ownerRow.locator('[data-test="role-select"]')).not.toBeVisible()
  })

  test('roles tab — admin cannot see transfer ownership button', async ({ page }) => {
    // WHY: roles-tab.tsx:255 — only callerRole === 'owner' renders the button.
    await authenticatePage(page, admin)
    await navigateToServer(page, server.id)

    await openServerSettings(page, server.id)

    await page.locator('[data-test="settings-tab-roles"]').click()

    const roleList = page.locator('[data-test="settings-role-list"]')
    await roleList.waitFor({ timeout: 10_000 })

    await expect(page.locator('[data-test="transfer-ownership-button"]')).not.toBeVisible()
  })

  test('overview tab — owner sees delete server section', async ({ page }) => {
    // WHY: overview-tab.tsx:129 — only callerRole === 'owner' renders DeleteServerSection.
    await authenticatePage(page, owner)
    await navigateToServer(page, server.id)

    await openServerSettings(page, server.id)

    // Overview is default tab — verify danger zone is visible for owner
    const deleteInput = page.locator('[data-test="delete-server-confirm-input"]')
    await expect(deleteInput).toBeVisible({ timeout: 10_000 })

    const deleteButton = page.locator('[data-test="delete-server-button"]')
    await expect(deleteButton).toBeVisible()
    // Delete button should be disabled until confirm input matches
    await expect(deleteButton).toBeDisabled()
  })

  test('overview tab — admin does NOT see delete server section', async ({ page }) => {
    // WHY: overview-tab.tsx:129 — DeleteServerSection only rendered for owner.
    await authenticatePage(page, admin)
    await navigateToServer(page, server.id)

    await openServerSettings(page, server.id)

    // Overview is default tab — delete section should NOT be visible for admin
    await expect(page.locator('[data-test="delete-server-confirm-input"]')).not.toBeVisible()
    await expect(page.locator('[data-test="delete-server-button"]')).not.toBeVisible()
  })

  test('settings can be closed via close button', async ({ page }) => {
    await authenticatePage(page, owner)
    await navigateToServer(page, server.id)

    await openServerSettings(page, server.id)

    // Click close button
    await page.locator('[data-test="close-settings-button"]').click()

    // Settings should disappear, main layout with channel sidebar returns
    const serverSettings = page.locator('[data-test="server-settings"]')
    await expect(serverSettings).not.toBeVisible({ timeout: 5_000 })
    await expect(page.locator('[data-test="channel-sidebar"]')).toBeVisible({ timeout: 10_000 })
  })
})
