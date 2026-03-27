/**
 * E2E Tests — Profile & Username Display
 *
 * Verifies that usernames are displayed correctly in the member list and
 * that profile information is visible via the member context menu.
 *
 * Real data-test attributes from:
 * - member-list.tsx:129 (member-list), :131 (member-count), :242 (member-item),
 *   :261 (member-username)
 * - member-context-menu.tsx:115 (member-context-menu), :187 (send-message-item)
 * - role-badge.tsx:24,33,42 (member-role-badge with data-role attr)
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

test.describe('Profile & Username Display', () => {
  let owner: TestUser
  let admin: TestUser
  let member: TestUser
  let server: { id: string; name: string }

  test.beforeAll(async () => {
    owner = await createTestUser('prof-owner')
    admin = await createTestUser('prof-admin')
    member = await createTestUser('prof-member')
    for (const u of [owner, admin, member]) await syncProfile(u.token)

    server = await createServer(owner.token, `Profile E2E ${Date.now()}`)
    const invite = await createInvite(owner.token, server.id)
    for (const u of [admin, member]) await joinServer(u.token, server.id, invite.code)

    await assignRole(owner.token, server.id, admin.id, 'admin')
  })

  // ── Username display in member list ──────────────────────────────

  test('each member shows username text in member list', async ({ page }) => {
    await authenticatePage(page, owner)
    await selectServer(page, server.id)

    const memberList = page.locator('[data-test="member-list"]')
    await memberList.waitFor({ timeout: 10_000 })

    // WHY: member-list.tsx:261 renders displayName = member.nickname ?? member.username.
    // createTestUser sets user_metadata.username = uniqueId, so each member should have
    // a non-empty username displayed.
    const memberItems = memberList.locator('[data-test="member-item"]')
    await expect(memberItems).toHaveCount(3, { timeout: 10_000 })

    // Verify each member-item has a visible, non-empty member-username element
    for (const userId of [owner.id, admin.id, member.id]) {
      const item = memberList.locator(`[data-test="member-item"][data-user-id="${userId}"]`)
      await expect(item).toBeVisible({ timeout: 10_000 })

      const username = item.locator('[data-test="member-username"]')
      await expect(username).toBeVisible()
      // WHY: Verify the username is not empty — catches regressions where displayName
      // resolves to null/undefined and renders an empty span.
      await expect(username).toContainText(/.+/)
    }
  })

  // ── Username contains the user prefix from creation ──────────────

  test('member username includes the user-factory prefix', async ({ page }) => {
    // WHY: createTestUser('prof-member') sets user_metadata.username to
    // "prof-member-<timestamp>-<random>". The displayName should contain the prefix,
    // confirming the profile sync pipeline works end-to-end.
    await authenticatePage(page, member)
    await selectServer(page, server.id)

    const memberList = page.locator('[data-test="member-list"]')
    await memberList.waitFor({ timeout: 10_000 })

    const memberItem = memberList.locator(`[data-test="member-item"][data-user-id="${member.id}"]`)
    await expect(memberItem).toBeVisible({ timeout: 10_000 })

    const username = memberItem.locator('[data-test="member-username"]')
    // WHY: The username starts with "prof-member" (the prefix passed to createTestUser).
    await expect(username).toContainText(/prof-member/)
  })

  // ── Role badge displayed alongside username ──────────────────────

  test('owner role badge displayed next to username', async ({ page }) => {
    await authenticatePage(page, member)
    await selectServer(page, server.id)

    const memberList = page.locator('[data-test="member-list"]')
    await memberList.waitFor({ timeout: 10_000 })

    const ownerItem = memberList.locator(`[data-test="member-item"][data-user-id="${owner.id}"]`)
    await expect(ownerItem).toBeVisible({ timeout: 10_000 })

    // WHY: role-badge.tsx renders data-test="member-role-badge" with data-role="owner"
    // for the owner role. Verify both the username and badge are visible on the same row.
    await expect(ownerItem.locator('[data-test="member-username"]')).toBeVisible()
    await expect(
      ownerItem.locator('[data-test="member-role-badge"][data-role="owner"]'),
    ).toBeVisible()
  })

  // ── Context menu shows "Send Message" for another member ─────────

  test('context menu on another member shows Send Message option', async ({ page }) => {
    // WHY: member-context-menu.tsx:85 — canSendMessage = isSelf === false.
    // Verifies that right-clicking a non-self member surfaces the Send Message action,
    // confirming the profile identity link between member-list and context-menu.
    await authenticatePage(page, owner)
    await selectServer(page, server.id)

    const memberList = page.locator('[data-test="member-list"]')
    await memberList.waitFor({ timeout: 10_000 })

    const memberItem = memberList.locator(`[data-test="member-item"][data-user-id="${member.id}"]`)
    await memberItem.waitFor({ timeout: 10_000 })

    // WHY: Dismiss any lingering popover before right-click (pattern from moderation.spec.ts).
    await page.keyboard.press('Escape')
    await memberItem.click({ button: 'right' })

    const contextMenu = page.locator('[data-test="member-context-menu"]')
    await contextMenu.waitFor({ timeout: 5_000 })

    const sendMessageItem = page.locator('[data-test="send-message-item"]')
    await expect(sendMessageItem).toBeVisible({ timeout: 5_000 })
  })

  // ── Self context menu shows no actions ───────────────────────────

  test('context menu on self shows no actions available', async ({ page }) => {
    // WHY: member-context-menu.tsx:35 — isSelf blocks all moderation + send-message.
    await authenticatePage(page, owner)
    await selectServer(page, server.id)

    const memberList = page.locator('[data-test="member-list"]')
    await memberList.waitFor({ timeout: 10_000 })

    const selfItem = memberList.locator(`[data-test="member-item"][data-user-id="${owner.id}"]`)
    await selfItem.waitFor({ timeout: 10_000 })

    await page.keyboard.press('Escape')
    await selfItem.click({ button: 'right' })

    const contextMenu = page.locator('[data-test="member-context-menu"]')
    await contextMenu.waitFor({ timeout: 5_000 })

    // WHY: member-context-menu.tsx:116 renders "no actions available" for self.
    await expect(page.locator('[data-test="no-actions-item"]')).toBeVisible({ timeout: 5_000 })
    await expect(page.locator('[data-test="send-message-item"]')).not.toBeAttached()
  })

  // ── Member count reflects server membership ──────────────────────

  test('member count header reflects actual member count', async ({ page }) => {
    await authenticatePage(page, owner)
    await selectServer(page, server.id)

    const memberList = page.locator('[data-test="member-list"]')
    await memberList.waitFor({ timeout: 10_000 })

    // WHY: member-list.tsx:131 renders data-test="member-count" with the total.
    // 3 members: owner, admin, member.
    const memberCount = page.locator('[data-test="member-count"]')
    await expect(memberCount).toHaveText(/3/, { timeout: 10_000 })
  })

  // ── New member appears in list after joining ─────────────────────

  test('new member appears in member list after joining server', async ({ page }) => {
    const newMember = await createTestUser('prof-newjoin')
    await syncProfile(newMember.token)

    const invite = await createInvite(owner.token, server.id)
    await joinServer(newMember.token, server.id, invite.code)

    await authenticatePage(page, owner)
    await selectServer(page, server.id)

    const memberList = page.locator('[data-test="member-list"]')
    await memberList.waitFor({ timeout: 10_000 })

    // Verify the new member appears
    const newItem = memberList.locator(`[data-test="member-item"][data-user-id="${newMember.id}"]`)
    await expect(newItem).toBeVisible({ timeout: 10_000 })

    // Verify the username contains the expected prefix
    const username = newItem.locator('[data-test="member-username"]')
    await expect(username).toContainText(/prof-newjoin/)
  })
})
