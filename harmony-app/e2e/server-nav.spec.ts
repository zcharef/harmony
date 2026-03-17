import { expect, type Page, test } from '@playwright/test'

async function loginAsAlice(page: Page) {
  await page.goto('/')
  await page.locator('[data-test="login-email-input"]').fill('alice@harmony.test')
  await page.locator('[data-test="login-password-input"]').fill('password123')
  await page.locator('[data-test="login-submit-button"]').click()
  await page.locator('[data-test="main-layout"]').waitFor({ timeout: 15000 })
}

test.describe('Server Navigation', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAlice(page)
  })

  test('should display server list with at least one server', async ({ page }) => {
    const serverList = page.locator('[data-test="server-list"]')
    await expect(serverList).toBeAttached()

    const serverButtons = page.locator('[data-test="server-button"]')
    const count = await serverButtons.count()
    expect(count).toBeGreaterThanOrEqual(1)

    const firstServerButton = serverButtons.first()
    await expect(firstServerButton).not.toHaveText('')
  })

  test('should show channel sidebar when clicking a server', async ({ page }) => {
    await page
      .locator('[data-test="server-button"][data-server-id="cccccccc-cccc-cccc-cccc-cccccccccccc"]')
      .click()

    const channelSidebar = page.locator('[data-test="channel-sidebar"]')
    await channelSidebar.waitFor({ timeout: 10000 })
    await expect(channelSidebar).toBeAttached()

    const serverNameHeader = page.locator('[data-test="server-name-header"]')
    await expect(serverNameHeader).toHaveText(/Harmony Dev/)
  })

  test('should display channels in the selected server', async ({ page }) => {
    await page
      .locator('[data-test="server-button"][data-server-id="cccccccc-cccc-cccc-cccc-cccccccccccc"]')
      .click()

    const channelSidebar = page.locator('[data-test="channel-sidebar"]')
    await channelSidebar.waitFor({ timeout: 10000 })

    const channelButtons = page.locator('[data-test="channel-button"]')
    await expect(channelButtons.first()).toBeAttached({ timeout: 10000 })
    const count = await channelButtons.count()
    expect(count).toBeGreaterThanOrEqual(1)

    const generalChannel = page.locator(
      '[data-test="channel-button"][data-channel-id="dddddddd-dddd-dddd-dddd-dddddddddddd"]',
    )
    await expect(generalChannel).toHaveText(/general/)
  })
})
