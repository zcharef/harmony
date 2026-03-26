import { expect, test } from '@playwright/test'
import { authenticatePage, selectServer } from './fixtures/auth-fixture'
import { createServer, syncProfile } from './fixtures/test-data-factory'
import { createTestUser, type TestUser } from './fixtures/user-factory'

test.describe('Invites', () => {
  let owner: TestUser
  let server: { id: string; name: string }

  test.beforeAll(async () => {
    owner = await createTestUser('inv-owner')
    await syncProfile(owner.token)
    server = await createServer(owner.token, `inv-test-${Date.now()}`)
  })

  test('should create an invite and display the code', async ({ page }) => {
    await authenticatePage(page, owner)
    await selectServer(page, server.id)

    // Open server menu and click "Invite People"
    await page.locator('[data-test="server-header-button"]').click()
    // WHY: Wait for dropdown to render — HeroUI dropdown has animation delay.
    const inviteItem = page.locator('[data-test="server-menu-invite-item"]')
    await inviteItem.waitFor({ timeout: 5_000 })
    await inviteItem.click()

    const dialog = page.locator('[data-test="create-invite-dialog"]')
    await expect(dialog).toBeVisible({ timeout: 5_000 })

    // Submit invite creation and wait for API response
    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/v1/servers/${server.id}/invites`) &&
        response.request().method() === 'POST',
    )
    await page.locator('[data-test="invite-submit-button"]').click()

    const response = await responsePromise
    expect(response.status()).toBeLessThan(400)
    const responseBody = (await response.json()) as { code: string }
    const inviteCode = responseBody.code
    expect(inviteCode.length).toBeGreaterThan(0)

    // Verify the generated invite code is displayed in the UI
    const codeDisplay = page.locator('[data-test="invite-code-display"]')
    // WHY: invite-code-display is an <input> element — use toHaveValue, not toContainText.
    await expect(codeDisplay).toHaveValue(inviteCode, { timeout: 10_000 })

    // Close the dialog
    await page.locator('[data-test="invite-done-button"]').click()
    await expect(dialog).not.toBeVisible({ timeout: 5_000 })
  })

  test('should preview an invite code in the join dialog', async ({ page }) => {
    await authenticatePage(page, owner)
    await selectServer(page, server.id)

    // Step 1: Create an invite via the UI to get a valid code
    await page.locator('[data-test="server-header-button"]').click()
    const inviteItem = page.locator('[data-test="server-menu-invite-item"]')
    await inviteItem.waitFor({ timeout: 5_000 })
    await inviteItem.click()

    const createDialog = page.locator('[data-test="create-invite-dialog"]')
    await expect(createDialog).toBeVisible({ timeout: 5_000 })

    const createResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/v1/servers/${server.id}/invites`) &&
        response.request().method() === 'POST',
    )
    await page.locator('[data-test="invite-submit-button"]').click()

    const createResponse = await createResponsePromise
    expect(createResponse.status()).toBeLessThan(400)
    const createBody = (await createResponse.json()) as { code: string }
    const inviteCode = createBody.code
    expect(inviteCode.length).toBeGreaterThan(0)

    // Close the create-invite dialog
    await page.locator('[data-test="invite-done-button"]').click()
    await expect(createDialog).not.toBeVisible({ timeout: 5_000 })

    // Step 2: Open the join server dialog
    await page.locator('[data-test="join-server-button"]').click()

    const joinDialog = page.locator('[data-test="join-server-dialog"]')
    await expect(joinDialog).toBeVisible({ timeout: 5_000 })

    // Fill in the invite code
    const codeInput = page.locator('[data-test="invite-code-input"]')
    await expect(codeInput).toBeVisible({ timeout: 5_000 })
    await codeInput.fill(inviteCode)

    // Preview the invite
    const previewResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/v1/invites/${inviteCode}`) &&
        response.request().method() === 'GET',
      { timeout: 15_000 },
    )

    await page.locator('[data-test="join-server-preview-button"]').click()

    const previewResponse = await previewResponsePromise
    expect(previewResponse.status()).toBeLessThan(400)

    // Verify server preview details
    const serverName = page.locator('[data-test="join-server-name"]')
    await expect(serverName).toHaveText(new RegExp(server.name))

    const memberCount = page.locator('[data-test="join-server-member-count"]')
    await expect(memberCount).toHaveText(/\d+/)

    // Go back without joining (owner is already a member)
    await page.locator('[data-test="join-server-back-button"]').click()
  })
})
