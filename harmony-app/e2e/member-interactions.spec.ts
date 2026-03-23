/**
 * E2E Tests — Member List & Context Menu Interactions
 *
 * Verifies the member list displays all server members with role badges, and
 * that the context menu enforces the strict role hierarchy for moderation
 * actions: owner(4) > admin(3) > moderator(2) > member(1).
 *
 * Permission rules (from member-context-menu.tsx:32-41):
 * - canChangeRole: outranksTarget AND callerRank >= admin(3)
 * - canKick:       outranksTarget AND callerRank >= moderator(2)
 * - canBan:        outranksTarget AND callerRank >= admin(3)
 * - canSendMessage: isSelf === false (always for non-self members)
 * - Self context menu: shows "no actions available" (isSelf blocks all)
 *
 * Real data-test attributes from:
 * - member-list.tsx:129 (member-list), :131 (member-count), :242 (member-item),
 *   :261 (member-username)
 * - member-context-menu.tsx:168 (send-message-item), :180 (role-{key}-item),
 *   :194/:207 (kick-member-item), :216 (ban-member-item)
 * - role-badge.tsx:24,33,42 (member-role-badge with data-role attr)
 * - kick-dialog.tsx:26 (kick-dialog), :40 (kick-cancel-button),
 *   :47 (kick-submit-button)
 * - ban-dialog.tsx:47 (ban-dialog), :62 (ban-reason-input),
 *   :71 (ban-cancel-button), :78 (ban-submit-button)
 * - main-layout.tsx:198 (main-layout)
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

test.describe('Member List & Context Menu', () => {
  let owner: TestUser
  let admin: TestUser
  let mod: TestUser
  let member: TestUser
  let server: { id: string; name: string }

  test.beforeAll(async () => {
    owner = await createTestUser('mctx-owner')
    admin = await createTestUser('mctx-admin')
    mod = await createTestUser('mctx-mod')
    member = await createTestUser('mctx-member')
    for (const u of [owner, admin, mod, member]) await syncProfile(u.token)

    server = await createServer(owner.token, `Members E2E ${Date.now()}`)
    const invite = await createInvite(owner.token, server.id)
    for (const u of [admin, mod, member]) await joinServer(u.token, server.id, invite.code)

    await assignRole(owner.token, server.id, admin.id, 'admin')
    await assignRole(owner.token, server.id, mod.id, 'moderator')
  })

  test('member list shows all server members with role badges', async ({ page }) => {
    await authenticatePage(page, owner)
    await page.goto('/')
    await page.locator('[data-test="main-layout"]').waitFor({ timeout: 15_000 })
    await selectServer(page, server.id)

    const memberList = page.locator('[data-test="member-list"]')
    await memberList.waitFor({ timeout: 10_000 })

    // Verify member count reflects all 4 members
    const memberCount = page.locator('[data-test="member-count"]')
    await expect(memberCount).toHaveText(/4/, { timeout: 10_000 })

    // Verify each member is present
    const memberItems = memberList.locator('[data-test="member-item"]')
    await expect(memberItems).toHaveCount(4, { timeout: 10_000 })

    // Verify owner has owner badge
    const ownerItem = memberList.locator(`[data-test="member-item"][data-user-id="${owner.id}"]`)
    await expect(
      ownerItem.locator('[data-test="member-role-badge"][data-role="owner"]'),
    ).toBeVisible()

    // Verify admin has admin badge
    const adminItem = memberList.locator(`[data-test="member-item"][data-user-id="${admin.id}"]`)
    await expect(
      adminItem.locator('[data-test="member-role-badge"][data-role="admin"]'),
    ).toBeVisible()

    // Verify moderator has moderator badge
    const modItem = memberList.locator(`[data-test="member-item"][data-user-id="${mod.id}"]`)
    await expect(
      modItem.locator('[data-test="member-role-badge"][data-role="moderator"]'),
    ).toBeVisible()

    // Verify member has no role badge (role-badge.tsx returns null for 'member')
    const memberItem = memberList.locator(`[data-test="member-item"][data-user-id="${member.id}"]`)
    await expect(memberItem).toBeVisible()
    await expect(memberItem.locator('[data-test="member-role-badge"]')).not.toBeVisible()
  })

  test('right-click member — context menu appears with Send Message', async ({ page }) => {
    await authenticatePage(page, owner)
    await page.goto('/')
    await page.locator('[data-test="main-layout"]').waitFor({ timeout: 15_000 })
    await selectServer(page, server.id)

    const memberList = page.locator('[data-test="member-list"]')
    await memberList.waitFor({ timeout: 10_000 })

    // Right-click the member to open context menu
    const memberItem = memberList.locator(`[data-test="member-item"][data-user-id="${member.id}"]`)
    await memberItem.waitFor({ timeout: 10_000 })
    await page.keyboard.press('Escape')
    await memberItem.click({ button: 'right' })
    await page.locator('[data-test="member-context-menu"]').waitFor({ timeout: 5_000 })

    // Verify "Send Message" is visible (always for non-self members)
    const sendMessageItem = page.locator('[data-test="send-message-item"]')
    await expect(sendMessageItem).toBeVisible({ timeout: 5_000 })
  })

  test('member right-clicks admin — no Kick/Ban/Role visible', async ({ page }) => {
    // WHY: member (rank 1) cannot moderate anyone. canKick, canBan, canChangeRole
    // all require callerRank > targetRank, plus minimum rank thresholds.
    await authenticatePage(page, member)
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

    // "Send Message" should be visible (non-self)
    const sendMsg = page.locator('[data-test="send-message-item"]')
    await sendMsg.waitFor({ timeout: 5_000 })

    // No moderation actions
    await expect(page.locator('[data-test="kick-member-item"]')).not.toBeVisible()
    await expect(page.locator('[data-test="ban-member-item"]')).not.toBeVisible()
    await expect(page.locator('[data-test="role-admin-item"]')).not.toBeVisible()
    await expect(page.locator('[data-test="role-moderator-item"]')).not.toBeVisible()
    await expect(page.locator('[data-test="role-member-item"]')).not.toBeVisible()
  })

  test('moderator right-clicks member — Kick visible, Ban NOT visible', async ({ page }) => {
    // WHY: moderator (rank 2) can kick members below them (rank 1).
    // canKick = outranksTarget AND callerRank >= moderator(2) => true.
    // canBan = outranksTarget AND callerRank >= admin(3) => false.
    await authenticatePage(page, mod)
    await page.goto('/')
    await page.locator('[data-test="main-layout"]').waitFor({ timeout: 15_000 })
    await selectServer(page, server.id)

    const memberList = page.locator('[data-test="member-list"]')
    await memberList.waitFor({ timeout: 10_000 })

    const memberItem = memberList.locator(`[data-test="member-item"][data-user-id="${member.id}"]`)
    await memberItem.waitFor({ timeout: 10_000 })
    await page.keyboard.press('Escape')
    await memberItem.click({ button: 'right' })
    await page.locator('[data-test="member-context-menu"]').waitFor({ timeout: 5_000 })

    // Kick should be visible
    const kickItem = page.locator('[data-test="kick-member-item"]')
    await expect(kickItem).toBeVisible({ timeout: 5_000 })

    // Ban should NOT be visible (requires admin+)
    await expect(page.locator('[data-test="ban-member-item"]')).not.toBeVisible()

    // Role change should NOT be visible (requires admin+)
    await expect(page.locator('[data-test="role-admin-item"]')).not.toBeVisible()
    await expect(page.locator('[data-test="role-moderator-item"]')).not.toBeVisible()
  })

  test('moderator right-clicks admin — no Kick visible (higher rank)', async ({ page }) => {
    // WHY: moderator (rank 2) does NOT outrank admin (rank 3).
    // outranksTarget = false, so canKick = false.
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

    // "Send Message" still visible (non-self)
    const sendMsg = page.locator('[data-test="send-message-item"]')
    await sendMsg.waitFor({ timeout: 5_000 })

    // No moderation actions against higher-ranked user
    await expect(page.locator('[data-test="kick-member-item"]')).not.toBeVisible()
    await expect(page.locator('[data-test="ban-member-item"]')).not.toBeVisible()
  })

  test('moderator right-clicks another moderator — no Kick visible (same rank)', async ({
    page,
  }) => {
    // WHY: Need a second moderator to test same-rank interactions.
    const mod2 = await createTestUser('mctx-mod2')
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

    // "Send Message" visible (non-self)
    const sendMsg = page.locator('[data-test="send-message-item"]')
    await sendMsg.waitFor({ timeout: 5_000 })

    // outranksTarget = false (same rank), so canKick = false
    await expect(page.locator('[data-test="kick-member-item"]')).not.toBeVisible()
    await expect(page.locator('[data-test="ban-member-item"]')).not.toBeVisible()
  })

  test('admin right-clicks member — Kick + Ban + Role visible', async ({ page }) => {
    // WHY: admin (rank 3) outranks member (rank 1).
    // canKick = true (rank >= moderator AND outranks)
    // canBan = true (rank >= admin AND outranks)
    // canChangeRole = true (rank >= admin AND outranks)
    await authenticatePage(page, admin)
    await page.goto('/')
    await page.locator('[data-test="main-layout"]').waitFor({ timeout: 15_000 })
    await selectServer(page, server.id)

    const memberList = page.locator('[data-test="member-list"]')
    await memberList.waitFor({ timeout: 10_000 })

    const memberItem = memberList.locator(`[data-test="member-item"][data-user-id="${member.id}"]`)
    await memberItem.waitFor({ timeout: 10_000 })
    await page.keyboard.press('Escape')
    await memberItem.click({ button: 'right' })
    await page.locator('[data-test="member-context-menu"]').waitFor({ timeout: 5_000 })

    // All moderation actions should be visible
    await expect(page.locator('[data-test="kick-member-item"]')).toBeVisible({ timeout: 5_000 })
    await expect(page.locator('[data-test="ban-member-item"]')).toBeVisible({ timeout: 5_000 })

    // Role assignment: admin can assign moderator and member (below their rank).
    // admin-role is filtered out because callerRank(3) is NOT > admin(3).
    // member-role is filtered out because it's the target's current role.
    await expect(page.locator('[data-test="role-moderator-item"]')).toBeVisible({
      timeout: 5_000,
    })
  })

  test('admin right-clicks owner — no Kick/Ban visible (higher rank)', async ({ page }) => {
    // WHY: admin (rank 3) does NOT outrank owner (rank 4).
    // outranksTarget = false, so all moderation actions are hidden.
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

    // "Send Message" visible (non-self)
    const sendMsg = page.locator('[data-test="send-message-item"]')
    await sendMsg.waitFor({ timeout: 5_000 })

    // No moderation actions against owner
    await expect(page.locator('[data-test="kick-member-item"]')).not.toBeVisible()
    await expect(page.locator('[data-test="ban-member-item"]')).not.toBeVisible()
    await expect(page.locator('[data-test="role-admin-item"]')).not.toBeVisible()
    await expect(page.locator('[data-test="role-moderator-item"]')).not.toBeVisible()
    await expect(page.locator('[data-test="role-member-item"]')).not.toBeVisible()
  })

  test('right-click self — no moderation actions available', async ({ page }) => {
    // WHY: member-context-menu.tsx:85 — canSendMessage = isSelf === false.
    // When isSelf is true AND no moderation actions: shows "no actions available".
    // member-context-menu.tsx:116 — renders the "no actions" fallback.
    await authenticatePage(page, owner)
    await page.goto('/')
    await page.locator('[data-test="main-layout"]').waitFor({ timeout: 15_000 })
    await selectServer(page, server.id)

    const memberList = page.locator('[data-test="member-list"]')
    await memberList.waitFor({ timeout: 10_000 })

    // Right-click the owner's own member item
    const selfItem = memberList.locator(`[data-test="member-item"][data-user-id="${owner.id}"]`)
    await selfItem.waitFor({ timeout: 10_000 })
    await page.keyboard.press('Escape')
    await selfItem.click({ button: 'right' })
    await page.locator('[data-test="member-context-menu"]').waitFor({ timeout: 5_000 })

    // "Send Message" should NOT be visible (isSelf === true)
    await expect(page.locator('[data-test="send-message-item"]')).not.toBeVisible({
      timeout: 3_000,
    })

    // No moderation actions on self
    await expect(page.locator('[data-test="kick-member-item"]')).not.toBeVisible()
    await expect(page.locator('[data-test="ban-member-item"]')).not.toBeVisible()
    await expect(page.locator('[data-test="role-admin-item"]')).not.toBeVisible()
    await expect(page.locator('[data-test="role-moderator-item"]')).not.toBeVisible()
  })
})
