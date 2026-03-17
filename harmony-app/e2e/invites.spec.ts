import { expect, type Page, test } from '@playwright/test'

const HARMONY_DEV_SERVER_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc'

async function loginAsAlice(page: Page) {
  await page.goto('/')
  await page.locator('[data-test="login-email-input"]').fill('alice@harmony.test')
  await page.locator('[data-test="login-password-input"]').fill('password123')
  await page.locator('[data-test="login-submit-button"]').click()
  await page.locator('[data-test="main-layout"]').waitFor({ timeout: 15000 })
}

async function navigateToHarmonyDev(page: Page) {
  await page
    .locator(`[data-test="server-button"][data-server-id="${HARMONY_DEV_SERVER_ID}"]`)
    .click()
  await page.locator('[data-test="channel-sidebar"]').waitFor({ timeout: 10000 })
}

async function openServerMenuAndCreateInvite(page: Page): Promise<string> {
  // Register response listener early — before any UI interaction
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().includes(`/v1/servers/${HARMONY_DEV_SERVER_ID}/invites`) &&
      response.request().method() === 'POST',
    { timeout: 30000 },
  )

  await page.locator('[data-test="server-name-header"]').click()
  await page.locator('[data-test="server-menu-invite-item"]').click()

  const dialog = page.locator('[data-test="create-invite-dialog"]')
  await expect(dialog).toBeVisible({ timeout: 5000 })

  await page.locator('[data-test="invite-submit-button"]').click()

  const response = await responsePromise
  expect(response.status()).toBeLessThan(400)

  const codeDisplay = page.locator('[data-test="invite-code-display"]')
  await expect(codeDisplay).toBeVisible({ timeout: 10000 })
  const inviteCode = await codeDisplay.inputValue()
  expect(inviteCode.length).toBeGreaterThan(0)

  return inviteCode
}

test.describe('Invites', () => {
  test('should create an invite and display the code', async ({ page }) => {
    await loginAsAlice(page)
    await navigateToHarmonyDev(page)

    const inviteCode = await openServerMenuAndCreateInvite(page)
    expect(inviteCode.length).toBeGreaterThan(0)

    await page.locator('[data-test="invite-done-button"]').click()

    await expect(page.locator('[data-test="create-invite-dialog"]')).not.toBeVisible()
  })

  test('should preview an invite code in the join dialog', async ({ page }) => {
    await loginAsAlice(page)
    await navigateToHarmonyDev(page)

    // Create an invite to get a valid code
    const inviteCode = await openServerMenuAndCreateInvite(page)
    await page.locator('[data-test="invite-done-button"]').click()
    await expect(page.locator('[data-test="create-invite-dialog"]')).not.toBeVisible()

    // Open the join server dialog
    await page.locator('[data-test="join-server-button"]').click()

    const joinDialog = page.locator('[data-test="join-server-dialog"]')
    await expect(joinDialog).toBeVisible({ timeout: 5000 })

    // Fill in the invite code
    const codeInput = page.locator('[data-test="invite-code-input"]')
    await codeInput.fill(inviteCode)
    await expect(codeInput).toHaveValue(inviteCode)

    // Preview the invite
    const previewResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/v1/invites/${inviteCode}`) &&
        response.request().method() === 'GET',
      { timeout: 15000 },
    )

    await page.locator('[data-test="join-server-preview-button"]').click()

    const previewResponse = await previewResponsePromise
    expect(previewResponse.status()).toBeLessThan(400)

    // Verify server preview details
    const serverName = page.locator('[data-test="join-server-name"]')
    await expect(serverName).toHaveText(/Harmony Dev/)

    const memberCount = page.locator('[data-test="join-server-member-count"]')
    await expect(memberCount).toBeVisible()
    await expect(memberCount).toHaveText(/\d+/)

    // Go back without joining (alice is already a member)
    await page.locator('[data-test="join-server-back-button"]').click()
  })
})
