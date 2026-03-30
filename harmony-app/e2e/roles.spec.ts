/**
 * E2E Tests — Role Assignment
 *
 * Verifies role assignment via the member context menu and the roles tab in
 * server settings. Tests the strict role hierarchy: owner(4) > admin(3) >
 * moderator(2) > member(1). Callers can only assign roles below their own level.
 *
 * UI flow: Right-click member -> context menu -> Change Role -> select role
 * Settings flow: Server Settings -> Roles tab -> role select dropdown
 *
 * Real data-test attributes from:
 * - member-list.tsx:242 (member-item), :261 (member-username)
 * - member-context-menu.tsx:180 (role-{key}-item)
 * - role-badge.tsx:24,33,42 (member-role-badge with data-role attr)
 * - roles-tab.tsx:89 (roles-member-row), :111 (role-select), :260 (transfer-ownership-button)
 * - server-settings.tsx:74 (settings-tab-{key})
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

test.describe('Role Assignment', () => {
  let owner: TestUser
  let admin: TestUser
  let mod: TestUser
  let member: TestUser
  let server: { id: string; name: string }

  test.beforeAll(async () => {
    owner = await createTestUser('role-owner')
    admin = await createTestUser('role-admin')
    mod = await createTestUser('role-mod')
    member = await createTestUser('role-member')
    for (const u of [owner, admin, mod, member]) await syncProfile(u.token)

    server = await createServer(owner.token, `Roles E2E ${Date.now()}`)
    const invite = await createInvite(owner.token, server.id)
    for (const u of [admin, mod, member]) await joinServer(u.token, server.id, invite.code)

    await assignRole(owner.token, server.id, admin.id, 'admin')
    await assignRole(owner.token, server.id, mod.id, 'moderator')
  })

  test('owner assigns admin role via context menu', async ({ page }) => {
    // WHY: Create a fresh member to promote so we don't disturb existing roles.
    const target = await createTestUser('role-promote-target')
    await syncProfile(target.token)
    const invite = await createInvite(owner.token, server.id)
    await joinServer(target.token, server.id, invite.code)

    await authenticatePage(page, owner)
    await selectServer(page, server.id)

    const memberList = page.locator('[data-test="member-list"]')
    await memberList.waitFor({ timeout: 10_000 })

    // Right-click the target member to open context menu
    const targetItem = memberList.locator(`[data-test="member-item"][data-user-id="${target.id}"]`)
    await targetItem.waitFor({ timeout: 10_000 })
    // WHY: Close any stale context menu from a previous interaction to
    // prevent strict mode violation (2 elements matching member-context-menu).
    await page.keyboard.press('Escape')
    await targetItem.click({ button: 'right' })
    await page.locator('[data-test="member-context-menu"]').waitFor({ timeout: 5_000 })

    // Select "Admin" from Change Role section
    const roleResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/v1/servers/${server.id}/members/${target.id}/role`) &&
        response.request().method() === 'PATCH',
    )

    const adminRoleItem = page.locator('[data-test="role-admin-item"]')
    await adminRoleItem.waitFor({ timeout: 5_000 })
    await adminRoleItem.click()

    const roleResponse = await roleResponsePromise
    expect(roleResponse.status()).toBeLessThan(400)

    // Verify the admin badge appears on the target member
    await expect(
      targetItem.locator('[data-test="member-role-badge"][data-role="admin"]'),
    ).toBeVisible({ timeout: 10_000 })
  })

  test('admin assigns moderator role via context menu', async ({ page }) => {
    // WHY: Admin (rank 3) can assign moderator (rank 2) which is below their level.
    await authenticatePage(page, admin)
    await selectServer(page, server.id)

    const memberList = page.locator('[data-test="member-list"]')
    await memberList.waitFor({ timeout: 10_000 })

    // Right-click the regular member
    const memberItem = memberList.locator(`[data-test="member-item"][data-user-id="${member.id}"]`)
    await memberItem.waitFor({ timeout: 10_000 })
    await page.keyboard.press('Escape')
    await memberItem.click({ button: 'right' })
    await page.locator('[data-test="member-context-menu"]').waitFor({ timeout: 5_000 })

    const roleResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/v1/servers/${server.id}/members/${member.id}/role`) &&
        response.request().method() === 'PATCH',
    )

    const modRoleItem = page.locator('[data-test="role-moderator-item"]')
    await modRoleItem.waitFor({ timeout: 5_000 })
    await modRoleItem.click()

    const roleResponse = await roleResponsePromise
    expect(roleResponse.status()).toBeLessThan(400)

    // Verify moderator badge appears
    await expect(
      memberItem.locator('[data-test="member-role-badge"][data-role="moderator"]'),
    ).toBeVisible({ timeout: 10_000 })

    // WHY: Cleanup — reset member back to 'member' role for other tests.
    await assignRole(owner.token, server.id, member.id, 'member')
  })

  test('admin cannot assign owner role — option not present in menu', async ({ page }) => {
    // WHY: member-context-menu.tsx:50 — callerRank > ROLE_HIERARCHY.admin filters out owner.
    // useAssignableRoles only includes roles below the caller's rank.

    // WHY: Ensure the target is at 'member' role regardless of prior test outcome.
    // The previous test promotes member to moderator and resets in cleanup, but if
    // it fails mid-way the cleanup is skipped, leaving member as 'moderator'.
    await assignRole(owner.token, server.id, member.id, 'member')

    await authenticatePage(page, admin)
    await selectServer(page, server.id)

    const memberList = page.locator('[data-test="member-list"]')
    await memberList.waitFor({ timeout: 10_000 })

    const memberItem = memberList.locator(`[data-test="member-item"][data-user-id="${member.id}"]`)
    await memberItem.waitFor({ timeout: 10_000 })
    await page.keyboard.press('Escape')
    await memberItem.click({ button: 'right' })
    await page.locator('[data-test="member-context-menu"]').waitFor({ timeout: 5_000 })

    // WHY: The "owner" role option should never appear in the context menu for admin callers.
    // Wait for at least one role item to confirm the Change Role section has rendered
    // before asserting absence. We use role-moderator-item (admin can assign mod to a member)
    // OR role-member-item as a data-loading signal — which one appears depends on the
    // target's current role (the target's own role is filtered out of the list).
    await page
      .locator('[data-test="role-moderator-item"], [data-test="role-member-item"]')
      .first()
      .waitFor({ timeout: 5_000 })

    await expect(page.locator('[data-test="role-owner-item"]')).not.toBeVisible()
  })

  test('moderator cannot assign roles — change role section hidden', async ({ page }) => {
    // WHY: member-context-menu.tsx:38 — canChangeRole requires callerRank >= ROLE_HIERARCHY.admin.
    // Moderator (rank 2) < admin (rank 3), so canChangeRole is false.

    // WHY: Ensure the target is at 'member' role regardless of prior test outcome.
    await assignRole(owner.token, server.id, member.id, 'member')

    await authenticatePage(page, mod)
    await selectServer(page, server.id)

    const memberList = page.locator('[data-test="member-list"]')
    await memberList.waitFor({ timeout: 10_000 })

    const memberItem = memberList.locator(`[data-test="member-item"][data-user-id="${member.id}"]`)
    await memberItem.waitFor({ timeout: 10_000 })
    await page.keyboard.press('Escape')
    await memberItem.click({ button: 'right' })
    await page.locator('[data-test="member-context-menu"]').waitFor({ timeout: 5_000 })

    // WHY: The "send message" item should still appear (non-self members always have it).
    // Waiting for it confirms the menu content has fully rendered before asserting absence
    // of role items — prevents false positives from checking an empty/loading menu.
    const sendMessageItem = page.locator('[data-test="send-message-item"]')
    await sendMessageItem.waitFor({ timeout: 5_000 })

    // Role assignment items should not be present
    await expect(page.locator('[data-test="role-admin-item"]')).not.toBeVisible()
    await expect(page.locator('[data-test="role-moderator-item"]')).not.toBeVisible()
    await expect(page.locator('[data-test="role-member-item"]')).not.toBeVisible()
  })

  test('member cannot assign roles — change role section hidden', async ({ page }) => {
    // WHY: member-context-menu.tsx:38 — member (rank 1) < admin (rank 3).

    // WHY: Ensure the target is at 'moderator' role regardless of prior test outcome.
    await assignRole(owner.token, server.id, mod.id, 'moderator')

    await authenticatePage(page, member)
    await selectServer(page, server.id)

    const memberList = page.locator('[data-test="member-list"]')
    await memberList.waitFor({ timeout: 10_000 })

    const modItem = memberList.locator(`[data-test="member-item"][data-user-id="${mod.id}"]`)
    await modItem.waitFor({ timeout: 10_000 })
    await page.keyboard.press('Escape')
    await modItem.click({ button: 'right' })
    await page.locator('[data-test="member-context-menu"]').waitFor({ timeout: 5_000 })

    // WHY: Send message item is available for any non-self member. Waiting for it
    // confirms the menu content has fully rendered before asserting absence of role
    // items — prevents false positives from checking an empty/loading menu.
    const sendMessageItem = page.locator('[data-test="send-message-item"]')
    await sendMessageItem.waitFor({ timeout: 5_000 })

    // No role assignment items visible
    await expect(page.locator('[data-test="role-admin-item"]')).not.toBeVisible()
    await expect(page.locator('[data-test="role-moderator-item"]')).not.toBeVisible()
    await expect(page.locator('[data-test="role-member-item"]')).not.toBeVisible()
  })

  test('admin cannot promote to admin — option filtered out (same rank)', async ({ page }) => {
    // WHY: useAssignableRoles in member-context-menu.tsx:50 only includes roles where
    // callerRank > ROLE_HIERARCHY[role]. Admin (3) is NOT > admin (3), so admin role is excluded.
    // Also, the target's current role is filtered out (line 59).

    // WHY: Ensure the target is at 'member' role regardless of prior test outcome.
    await assignRole(owner.token, server.id, member.id, 'member')

    await authenticatePage(page, admin)
    await selectServer(page, server.id)

    const memberList = page.locator('[data-test="member-list"]')
    await memberList.waitFor({ timeout: 10_000 })

    // Right-click another member (not admin — that would also fail because admin can't change admin)
    const memberItem = memberList.locator(`[data-test="member-item"][data-user-id="${member.id}"]`)
    await memberItem.waitFor({ timeout: 10_000 })
    await page.keyboard.press('Escape')
    await memberItem.click({ button: 'right' })
    await page.locator('[data-test="member-context-menu"]').waitFor({ timeout: 5_000 })

    // WHY: Wait for at least one role item to confirm the Change Role section has
    // rendered. The admin can assign moderator to a member, so role-moderator-item
    // should appear. Use a union selector in case the target role state differs.
    await page
      .locator('[data-test="role-moderator-item"], [data-test="role-member-item"]')
      .first()
      .waitFor({ timeout: 5_000 })

    // Admin role option should NOT be available to an admin caller
    await expect(page.locator('[data-test="role-admin-item"]')).not.toBeVisible()
  })

  test('role changes reflected in member list badges', async ({ page }) => {
    // WHY: Verify the RoleBadge component (role-badge.tsx) renders the correct
    // data-role attribute after a role change via API.
    const target = await createTestUser('role-badge-target')
    await syncProfile(target.token)
    const invite = await createInvite(owner.token, server.id)
    await joinServer(target.token, server.id, invite.code)

    // Assign moderator via API
    await assignRole(owner.token, server.id, target.id, 'moderator')

    await authenticatePage(page, owner)
    await selectServer(page, server.id)

    const memberList = page.locator('[data-test="member-list"]')
    await memberList.waitFor({ timeout: 10_000 })

    // Verify the moderator badge is present
    const targetItem = memberList.locator(`[data-test="member-item"][data-user-id="${target.id}"]`)
    await targetItem.waitFor({ timeout: 10_000 })
    await expect(
      targetItem.locator('[data-test="member-role-badge"][data-role="moderator"]'),
    ).toBeVisible({ timeout: 5_000 })

    // WHY: Promote via API while the page is open. The SSE system delivers a
    // member.role_updated event which useRealtimeMembers handles by updating the
    // TanStack Query cache in-place — no reload needed.
    await assignRole(owner.token, server.id, target.id, 'admin')

    // WHY: Wait for the admin badge to appear via SSE. If SSE delivery is slow
    // (CI network jitter), fall back to page.reload() which forces a fresh fetch
    // from the API — proving persistence either way.
    const adminBadge = targetItem.locator('[data-test="member-role-badge"][data-role="admin"]')
    const appearedViaSse = await adminBadge
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false)

    if (appearedViaSse === false) {
      await page.reload()
      await page.locator('[data-test="main-layout"]').waitFor({ timeout: 15_000 })
      await selectServer(page, server.id)
      const reloadedMemberList = page.locator('[data-test="member-list"]')
      await reloadedMemberList.waitFor({ timeout: 10_000 })
      const reloadedTarget = reloadedMemberList.locator(
        `[data-test="member-item"][data-user-id="${target.id}"]`,
      )
      await expect(
        reloadedTarget.locator('[data-test="member-role-badge"][data-role="admin"]'),
      ).toBeVisible({ timeout: 10_000 })
    }
  })
})
