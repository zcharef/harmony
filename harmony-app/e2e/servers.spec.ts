import { expect, test } from '@playwright/test'
import { authenticatePage } from './fixtures/auth-fixture'
import { createInvite, createServer, joinServer, syncProfile } from './fixtures/test-data-factory'
import { createTestUser, type TestUser } from './fixtures/user-factory'

test.describe('Server CRUD', () => {
  let owner: TestUser
  let member: TestUser
  let server: { id: string; name: string }

  test.beforeAll(async () => {
    owner = await createTestUser('srv-owner')
    member = await createTestUser('srv-member')
    await syncProfile(owner.token)
    await syncProfile(member.token)
    server = await createServer(owner.token, `E2E Server ${Date.now()}`)
    const invite = await createInvite(owner.token, server.id)
    await joinServer(member.token, server.id, invite.code)
  })

  // ── Create server ──────────────────────────────────────────────

  test('create a new server and verify it appears in server sidebar', async ({ page }) => {
    // WHY: authenticatePage already navigates to / and waits for main-layout.
    // A redundant page.goto('/') causes a second page load that can race with
    // Supabase session recovery, leading to stale/cleared auth tokens.
    await authenticatePage(page, owner)

    // BEFORE: count existing server buttons
    const serverButtonsBefore = page.locator('[data-test="server-button"]')
    await serverButtonsBefore.first().waitFor({ timeout: 10000 })
    const countBefore = await serverButtonsBefore.count()

    // ACTION: open create server dialog
    const addButton = page.locator('[data-test="add-server-button"]')
    await addButton.click()

    const dialog = page.locator('[data-test="create-server-dialog"]')
    await expect(dialog).toBeVisible({ timeout: 5000 })

    const newServerName = `Created ${Date.now()}`
    const nameInput = page.locator('[data-test="server-name-input"]')
    await nameInput.fill(newServerName)
    await expect(nameInput).toHaveValue(newServerName)

    // Submit and wait for API response
    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().includes('/v1/servers') && response.request().method() === 'POST',
    )
    await page.locator('[data-test="create-server-submit-button"]').click()

    const response = await responsePromise
    expect(response.status()).toBeLessThan(400)

    const body = (await response.json()) as { id: string }
    const newServerId = body.id

    // AFTER: dialog closes
    await expect(dialog).not.toBeVisible({ timeout: 5000 })

    // AFTER: new server button appears in sidebar
    const newServerButton = page.locator(
      `[data-test="server-button"][data-server-id="${newServerId}"]`,
    )
    await expect(newServerButton).toBeVisible({ timeout: 10000 })

    // AFTER: count increased
    const serverButtonsAfter = page.locator('[data-test="server-button"]')
    const countAfter = await serverButtonsAfter.count()
    expect(countAfter).toBe(countBefore + 1)
  })

  // ── Click server shows #general ────────────────────────────────

  test('clicking server icon shows auto-created general channel', async ({ page }) => {
    await authenticatePage(page, owner)

    // ACTION: click the server button
    const serverButton = page.locator(`[data-test="server-button"][data-server-id="${server.id}"]`)
    await expect(serverButton).toBeVisible({ timeout: 10000 })
    await serverButton.click()

    // AFTER: channel sidebar appears
    const channelSidebar = page.locator('[data-test="channel-sidebar"]')
    await expect(channelSidebar).toBeVisible({ timeout: 10000 })

    // AFTER: server name is shown in header
    const serverNameHeader = page.locator('[data-test="server-name-header"]')
    await expect(serverNameHeader).toHaveText(new RegExp(server.name))

    // AFTER: #general channel exists (auto-created on server creation)
    const channelButtons = page.locator('[data-test="channel-button"]')
    await expect(channelButtons.first()).toBeVisible({ timeout: 10000 })
    const channelCount = await channelButtons.count()
    expect(channelCount).toBeGreaterThanOrEqual(1)

    // WHY: The API auto-creates a "general" channel when a server is created.
    const generalChannel = page.locator('[data-test="channel-button"][data-channel-name="general"]')
    await expect(generalChannel).toBeVisible()
  })

  // ── Update server name (admin) ─────────────────────────────────

  test('owner can update server name via settings', async ({ page }) => {
    // WHY: Create a dedicated server so renaming doesn't affect other tests.
    const renameServer = await createServer(owner.token, `Rename Me ${Date.now()}`)

    await authenticatePage(page, owner)

    // Navigate to the server
    const serverButton = page.locator(
      `[data-test="server-button"][data-server-id="${renameServer.id}"]`,
    )
    await expect(serverButton).toBeVisible({ timeout: 10000 })
    await serverButton.click()

    const channelSidebar = page.locator('[data-test="channel-sidebar"]')
    await expect(channelSidebar).toBeVisible({ timeout: 10000 })

    // Open server settings via server header dropdown
    await page.locator('[data-test="server-header-button"]').click()

    // WHY: useMyMemberRole defaults to 'member' while the members query loads,
    // which makes canAccessSettings=false and hides the settings item via
    // Tailwind 'hidden' class. Once the members query resolves and the owner
    // role is detected, canAccessSettings becomes true and the class is removed.
    // Using state:'visible' retries until the element is no longer display:none.
    const settingsItem = page.locator('[data-test="server-menu-settings-item"]')
    await settingsItem.waitFor({ state: 'visible', timeout: 10_000 })
    await settingsItem.click()

    // AFTER: server settings page renders
    const settingsPage = page.locator('[data-test="server-settings"]')
    await expect(settingsPage).toBeVisible({ timeout: 10000 })

    // Overview tab is active by default — update the server name
    const nameInput = page.locator('[data-test="settings-server-name-input"]')
    await expect(nameInput).toBeVisible({ timeout: 5000 })

    // BEFORE: verify current name
    await expect(nameInput).toHaveValue(renameServer.name)

    const updatedName = `Renamed ${Date.now()}`
    await nameInput.clear()
    await nameInput.fill(updatedName)
    await expect(nameInput).toHaveValue(updatedName)

    // Submit rename
    const saveButton = page.locator('[data-test="settings-save-overview-button"]')
    await expect(saveButton).toBeEnabled()

    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/v1/servers/${renameServer.id}`) &&
        response.request().method() === 'PATCH',
    )
    await saveButton.click()

    const response = await responsePromise
    expect(response.status()).toBeLessThan(400)

    // AFTER: close settings and verify name changed in sidebar
    await page.locator('[data-test="close-settings-button"]').click()
    await expect(settingsPage).not.toBeVisible({ timeout: 5000 })

    const serverNameHeader = page.locator('[data-test="server-name-header"]')
    await expect(serverNameHeader).toHaveText(new RegExp(updatedName))
  })

  // ── Member cannot update server name ───────────────────────────

  test('member cannot access server settings to update name', async ({ page }) => {
    await authenticatePage(page, member)

    // Navigate to the server as member
    const serverButton = page.locator(`[data-test="server-button"][data-server-id="${server.id}"]`)
    await expect(serverButton).toBeVisible({ timeout: 10000 })
    await serverButton.click()

    const channelSidebar = page.locator('[data-test="channel-sidebar"]')
    await expect(channelSidebar).toBeVisible({ timeout: 10000 })

    // Open server header dropdown
    await page.locator('[data-test="server-header-button"]').click()

    // WHY: Wait for an always-visible dropdown item to confirm the menu rendered.
    // HeroUI dropdown has animation delay; the 'leave' item is always shown.
    const leaveItem = page.locator('[data-test="server-menu-leave-item"]')
    await leaveItem.waitFor({ state: 'visible', timeout: 5_000 })

    // AFTER: settings item is hidden for members (className='hidden' when !canAccessSettings)
    const settingsItem = page.locator('[data-test="server-menu-settings-item"]')
    await expect(settingsItem).toBeHidden()
  })
})
