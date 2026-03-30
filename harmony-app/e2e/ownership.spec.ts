/**
 * E2E Tests — Ownership Transfer
 *
 * Verifies the server ownership transfer flow, which is accessed from the
 * Roles tab in Server Settings. Only the current owner sees the transfer button.
 *
 * UI flow: Server Settings -> Roles tab -> Transfer Ownership button -> modal
 *
 * Real data-test attributes from:
 * - roles-tab.tsx:260 (transfer-ownership-button)
 * - roles-tab.tsx:161 (transfer-ownership-modal)
 * - roles-tab.tsx:175 (transfer-owner-select)
 * - roles-tab.tsx:191 (confirm-transfer-button)
 * - roles-tab.tsx:89 (roles-member-row)
 * - server-settings.tsx:74 (settings-tab-roles)
 * - role-badge.tsx:24 (member-role-badge with data-role)
 */
import { expect, test } from '@playwright/test'
import { authenticatePage, selectServer } from './fixtures/auth-fixture'
import {
  assignRole,
  createInvite,
  createServer,
  joinServer,
  syncProfile,
} from './fixtures/test-data-factory'
import { createTestUser, type TestUser } from './fixtures/user-factory'

// WHY: Configurable for CI (deployed API) while defaulting to local dev.
const API_URL = process.env.VITE_API_URL ?? 'http://localhost:3000'

test.describe('Ownership Transfer', () => {
  let owner: TestUser
  let admin: TestUser
  let member: TestUser
  let server: { id: string; name: string }

  test.beforeAll(async () => {
    owner = await createTestUser('own-owner')
    admin = await createTestUser('own-admin')
    member = await createTestUser('own-member')
    for (const u of [owner, admin, member]) await syncProfile(u.token)

    server = await createServer(owner.token, `Owner E2E ${Date.now()}`)
    const invite = await createInvite(owner.token, server.id)
    for (const u of [admin, member]) await joinServer(u.token, server.id, invite.code)

    await assignRole(owner.token, server.id, admin.id, 'admin')
  })

  test('owner transfers ownership to admin via roles tab', async ({ page }) => {
    // WHY: This test creates its own server to avoid mutating shared state,
    // since ownership transfer is a destructive action that changes the owner.
    const transferOwner = await createTestUser('own-xfer-owner')
    const transferAdmin = await createTestUser('own-xfer-admin')
    for (const u of [transferOwner, transferAdmin]) await syncProfile(u.token)

    const transferServer = await createServer(transferOwner.token, `Transfer E2E ${Date.now()}`)
    const invite = await createInvite(transferOwner.token, transferServer.id)
    await joinServer(transferAdmin.token, transferServer.id, invite.code)
    await assignRole(transferOwner.token, transferServer.id, transferAdmin.id, 'admin')

    await authenticatePage(page, transferOwner)
    await selectServer(page, transferServer.id)

    // WHY: Wait for member-list to render, which proves the members query succeeded
    // and useMyMemberRole has resolved the caller's role. Without this, the
    // server-menu-settings-item may have class="hidden" because canAccessSettings
    // defaults to false while the members query is still pending.
    await page.locator('[data-test="member-list"]').waitFor({ timeout: 15_000 })

    // Open server settings via server header menu
    await page.locator('[data-test="server-header-button"]').click()
    // WHY: Wait for dropdown to render — HeroUI dropdown has animation delay.
    const settingsItem = page.locator('[data-test="server-menu-settings-item"]')
    await settingsItem.waitFor({ timeout: 5_000 })
    await settingsItem.click()

    const serverSettings = page.locator('[data-test="server-settings"]')
    await serverSettings.waitFor({ timeout: 10_000 })

    // Navigate to Roles tab
    await page.locator('[data-test="settings-tab-roles"]').click()

    // Click Transfer Ownership button
    const transferButton = page.locator('[data-test="transfer-ownership-button"]')
    await transferButton.waitFor({ timeout: 10_000 })
    await transferButton.click()

    // Transfer ownership modal opens
    const transferModal = page.locator('[data-test="transfer-ownership-modal"]')
    await expect(transferModal).toBeVisible({ timeout: 5_000 })

    // Select the admin as new owner from the dropdown
    const ownerSelect = page.locator('[data-test="transfer-owner-select"]')
    await ownerSelect.click()

    // WHY: HeroUI Select renders options in a listbox. Click the option by data-test.
    const option = page.locator(`[data-test="transfer-option-${transferAdmin.id}"]`)
    await option.waitFor({ timeout: 5_000 })
    await option.click()

    // Confirm the transfer
    const transferResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/v1/servers/${transferServer.id}/transfer-ownership`) &&
        response.request().method() === 'POST',
    )

    await page.locator('[data-test="confirm-transfer-button"]').click()

    const transferResponse = await transferResponsePromise
    expect(transferResponse.status()).toBe(200)

    // Modal closes
    await expect(transferModal).not.toBeVisible({ timeout: 5_000 })

    // WHY: Verify the transfer persisted by reloading — this fetches fresh data
    // from the API instead of depending on SSE event delivery timing (flaky in CI).
    // SSE realtime delivery is already covered by realtime-sync.spec.ts.
    await page.reload()
    await page.locator('[data-test="main-layout"]').waitFor({ timeout: 15_000 })
    await selectServer(page, transferServer.id)

    const memberList = page.locator('[data-test="member-list"]')
    await memberList.waitFor({ timeout: 15_000 })

    // The new owner should have the owner badge
    const newOwnerItem = memberList.locator(
      `[data-test="member-item"][data-user-id="${transferAdmin.id}"]`,
    )
    await expect(
      newOwnerItem.locator('[data-test="member-role-badge"][data-role="owner"]'),
    ).toBeVisible({ timeout: 10_000 })

    // The old owner should now have the admin badge
    const oldOwnerItem = memberList.locator(
      `[data-test="member-item"][data-user-id="${transferOwner.id}"]`,
    )
    await expect(
      oldOwnerItem.locator('[data-test="member-role-badge"][data-role="admin"]'),
    ).toBeVisible({ timeout: 10_000 })
  })

  test('non-owner cannot see transfer ownership button', async ({ page }) => {
    // WHY: roles-tab.tsx:255 — only callerRole === 'owner' renders the transfer button.
    await authenticatePage(page, admin)
    await selectServer(page, server.id)

    // WHY: Wait for member-list to render, proving the members query succeeded
    // and useMyMemberRole resolved the admin role (canAccessSettings = true).
    await page.locator('[data-test="member-list"]').waitFor({ timeout: 15_000 })

    // Open server settings
    await page.locator('[data-test="server-header-button"]').click()
    // WHY: Wait for dropdown to render — HeroUI dropdown has animation delay.
    const settingsItem = page.locator('[data-test="server-menu-settings-item"]')
    await settingsItem.waitFor({ timeout: 5_000 })
    await settingsItem.click()

    const serverSettings = page.locator('[data-test="server-settings"]')
    await serverSettings.waitFor({ timeout: 10_000 })

    // Navigate to Roles tab
    await page.locator('[data-test="settings-tab-roles"]').click()

    // Wait for the roles list to load
    const roleList = page.locator('[data-test="settings-role-list"]')
    await roleList.waitFor({ timeout: 10_000 })

    // Transfer button should NOT be visible to admin
    await expect(page.locator('[data-test="transfer-ownership-button"]')).not.toBeVisible()
  })

  test('cannot transfer ownership to non-member via API', async ({ page }) => {
    // WHY: The API should reject transfer-ownership to a user who is not a member.
    // This is tested at the API level since the UI select only shows current members.
    const nonMember = await createTestUser('own-non-member')
    await syncProfile(nonMember.token)

    const res = await fetch(`${API_URL}/v1/servers/${server.id}/transfer-ownership`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${owner.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ newOwnerId: nonMember.id }),
    })

    // WHY: moderation_service.rs:335 — non-member triggers DomainError::NotFound → 404.
    expect(res.status).toBe(404)

    // Verify the owner is still the owner via the member list
    await authenticatePage(page, owner)
    await selectServer(page, server.id)

    // WHY: Wait for member-list to render, proving the members query succeeded.
    const memberList = page.locator('[data-test="member-list"]')
    await memberList.waitFor({ timeout: 15_000 })

    const ownerItem = memberList.locator(`[data-test="member-item"][data-user-id="${owner.id}"]`)
    await ownerItem.waitFor({ timeout: 10_000 })
    await expect(
      ownerItem.locator('[data-test="member-role-badge"][data-role="owner"]'),
    ).toBeVisible({ timeout: 5_000 })
  })
})
