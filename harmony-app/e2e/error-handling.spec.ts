import { expect, test } from '@playwright/test'
import { authenticatePage } from './fixtures/auth-fixture'
import { createServer, syncProfile } from './fixtures/test-data-factory'
import { createTestUser, type TestUser } from './fixtures/user-factory'

/**
 * Error handling E2E tests.
 *
 * WHY limited scope: Tests that require simulating network errors or API failures
 * would need page.route() (mocking), which violates the mandatory no-mock rule.
 * We test only scenarios achievable without mocking:
 * - Expired/cleared session → login page redirect
 */

test.describe('Error Handling', () => {
  let user: TestUser

  test.beforeAll(async () => {
    user = await createTestUser('err-session-exp')
    await syncProfile(user.token)
    await createServer(user.token)
  })

  // ── Expired Session Handling ───────────────────────────────────

  test('expired session redirects to login page', async ({ page }) => {
    // Authenticate and verify main layout loads
    await authenticatePage(page, user)

    const mainLayout = page.locator('[data-test="main-layout"]')
    await expect(mainLayout).toBeVisible({ timeout: 15000 })

    // WHY: authenticatePage uses addInitScript which persists across page.reload(),
    // re-populating localStorage before the app JS runs. To test expired session,
    // we open a new page in the same context (shares localStorage) AFTER clearing it.
    // The new page has no addInitScript registered, so the cleared storage stays empty.
    await page.evaluate(() => {
      localStorage.clear()
      sessionStorage.clear()
    })

    // Open a fresh page in the same browser context (no addInitScript).
    // This simulates a user returning to the app after their session expired.
    const freshPage = await page.context().newPage()
    await freshPage.goto('/')

    const loginPage = freshPage.locator('[data-test="login-page"]')
    await expect(loginPage).toBeVisible({ timeout: 15000 })
    // WHY: Bare toBeVisible only confirms the locator matched — verify it's actually
    // the login page by checking for the email input form element.
    await expect(freshPage.locator('[data-test="login-email-input"]')).toBeVisible()

    await freshPage.close()
  })
})
