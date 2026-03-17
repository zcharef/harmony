import { expect, type Page, test } from '@playwright/test'

const HARMONY_DEV_SERVER_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc'

async function loginAsAlice(page: Page) {
  await page.goto('/')
  await page.locator('[data-test="login-email-input"]').fill('alice@harmony.test')
  await page.locator('[data-test="login-password-input"]').fill('password123')
  await page.locator('[data-test="login-submit-button"]').click()
  await page.locator('[data-test="main-layout"]').waitFor({ timeout: 15000 })
}

test.describe('Members', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAlice(page)
    await page
      .locator(`[data-test="server-button"][data-server-id="${HARMONY_DEV_SERVER_ID}"]`)
      .click()
  })

  test('should display member list with member count', async ({ page }) => {
    const memberList = page.locator('[data-test="member-list"]')
    await memberList.waitFor({ timeout: 10000 })

    const memberCount = page.locator('[data-test="member-count"]')
    await expect(memberCount).toHaveText(/2/)
  })

  test('should list server members with usernames', async ({ page }) => {
    const memberList = page.locator('[data-test="member-list"]')
    await memberList.waitFor({ timeout: 10000 })

    const memberItems = page.locator('[data-test="member-item"]')
    const count = await memberItems.count()
    expect(count).toBeGreaterThanOrEqual(2)

    const allUsernames = page.locator('[data-test="member-username"]')
    await expect(allUsernames.filter({ hasText: 'alice' })).toHaveCount(1)
    await expect(allUsernames.filter({ hasText: 'bob' })).toHaveCount(1)
  })
})
