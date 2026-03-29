import { expect, test } from '@playwright/test'
import { createTestUser } from './fixtures/user-factory'

test.describe('Authentication', () => {
  test('should render login page with all required elements', async ({ page }) => {
    await page.goto('/')

    // WHY: login-heading is an <img> with alt text, not a text element.
    const heading = page.locator('[data-test="login-heading"]')
    await expect(heading).toHaveAttribute('alt', 'Harmony')

    const subtitle = page.locator('[data-test="login-subtitle"]')
    await expect(subtitle).toHaveText(/Welcome back!/)

    const emailInput = page.locator('[data-test="login-email-input"]')
    await expect(emailInput).toBeAttached()

    const passwordInput = page.locator('[data-test="login-password-input"]')
    await expect(passwordInput).toBeAttached()

    const submitButton = page.locator('[data-test="login-submit-button"]')
    await expect(submitButton).toHaveText(/Sign In/)

    const toggleButton = page.locator('[data-test="login-toggle-button"]')
    await expect(toggleButton).toHaveText(/Sign up/i)
  })

  test('should toggle between login and signup modes', async ({ page }) => {
    await page.goto('/')

    const subtitle = page.locator('[data-test="login-subtitle"]')
    await expect(subtitle).toHaveText(/Welcome back!/)

    const toggleButton = page.locator('[data-test="login-toggle-button"]')
    await toggleButton.click()

    await expect(subtitle).toHaveText(/Create your account/)

    const submitButton = page.locator('[data-test="login-submit-button"]')
    await expect(submitButton).toHaveText(/Sign Up/)

    await toggleButton.click()

    await expect(subtitle).toHaveText(/Welcome back!/)
  })

  test('should show password requirement hints during signup', async ({ page }) => {
    await page.goto('/')

    // Switch to signup mode
    const toggleButton = page.locator('[data-test="login-toggle-button"]')
    await toggleButton.click()

    const passwordInput = page.locator('[data-test="login-password-input"]')

    // WHY: Hints only appear once the user starts typing
    await passwordInput.fill('a')
    await expect(passwordInput).toHaveValue('a')

    // All three requirement indicators should be visible
    const lengthReq = page.locator('[data-test="pw-req-length"]')
    const letterReq = page.locator('[data-test="pw-req-letter"]')
    const digitReq = page.locator('[data-test="pw-req-digit"]')

    await expect(lengthReq).toBeVisible()
    await expect(letterReq).toBeVisible()
    await expect(digitReq).toBeVisible()

    // 'a' satisfies letter but not length or digit
    await expect(letterReq).toHaveAttribute('data-state', 'pass')
    await expect(lengthReq).toHaveAttribute('data-state', 'fail')
    await expect(digitReq).toHaveAttribute('data-state', 'fail')

    // Satisfy all requirements
    await passwordInput.fill('abcdefg1')
    await expect(passwordInput).toHaveValue('abcdefg1')

    await expect(lengthReq).toHaveAttribute('data-state', 'pass')
    await expect(letterReq).toHaveAttribute('data-state', 'pass')
    await expect(digitReq).toHaveAttribute('data-state', 'pass')
  })

  test('should not show password hints on login mode', async ({ page }) => {
    await page.goto('/')

    const passwordInput = page.locator('[data-test="login-password-input"]')
    await passwordInput.fill('short')
    await expect(passwordInput).toHaveValue('short')

    // WHY: Hints are conditionally rendered — not in the DOM at all in login mode
    await expect(page.locator('[data-test="pw-req-length"]')).not.toBeAttached()
  })

  test('should disable signup button when password is invalid', async ({ page }) => {
    await page.goto('/')

    // Switch to signup mode
    const toggleButton = page.locator('[data-test="login-toggle-button"]')
    await toggleButton.click()

    const usernameInput = page.locator('[data-test="login-username-input"]')
    await usernameInput.fill('validuser')
    await expect(usernameInput).toHaveValue('validuser')

    const emailInput = page.locator('[data-test="login-email-input"]')
    await emailInput.fill('test@example.com')
    await expect(emailInput).toHaveValue('test@example.com')

    const passwordInput = page.locator('[data-test="login-password-input"]')
    await passwordInput.fill('short')
    await expect(passwordInput).toHaveValue('short')

    // WHY: Even after captcha resolves, button stays disabled with an invalid password
    const submitButton = page.locator('[data-test="login-submit-button"]')
    await expect(submitButton).toBeDisabled()

    // Satisfy password requirements
    await passwordInput.fill('validpass1')
    await expect(passwordInput).toHaveValue('validpass1')

    // WHY: Button may still be disabled if captcha or username check hasn't resolved,
    // but we verify it's not disabled due to password alone by checking the attribute
    // after a valid password is provided. The captcha test key auto-passes.
    await expect(submitButton).toBeEnabled({ timeout: 10000 })
  })

  test('should show error message for invalid credentials', async ({ page }) => {
    await page.goto('/')

    const emailInput = page.locator('[data-test="login-email-input"]')
    await emailInput.fill('bad@test.com')
    await expect(emailInput).toHaveValue('bad@test.com')

    const passwordInput = page.locator('[data-test="login-password-input"]')
    await passwordInput.fill('wrongpass')
    await expect(passwordInput).toHaveValue('wrongpass')

    // WHY: Submit button is disabled until Turnstile widget resolves.
    // With test site key (1x00000000000000000000AA), it auto-passes.
    const submitButton = page.locator('[data-test="login-submit-button"]')
    await expect(submitButton).toBeEnabled({ timeout: 10000 })

    const responsePromise = page.waitForResponse((response) =>
      response.url().includes('/auth/v1/token'),
    )

    await submitButton.click()

    const response = await responsePromise
    expect(response.status()).toBeGreaterThanOrEqual(400)

    const errorMessage = page.locator('[data-test="login-error-message"]')
    await expect(errorMessage).toBeAttached()
    await expect(errorMessage).not.toHaveText('')
  })

  test('should return 401 on protected endpoint without auth', async ({ request }) => {
    // WHY: Validates that the Rust API's JWT middleware is correctly wired up
    // and rejects unauthenticated requests with 401 (not 500 or 403).
    // Uses Playwright's request fixture (Node-level HTTP) to bypass browser CORS.
    const response = await request.get('http://localhost:3000/v1/servers')
    expect(response.status()).toBe(401)
  })

  test('should return 401 on protected endpoint with invalid token', async ({ request }) => {
    // WHY: Ensures the API rejects garbage Bearer tokens, not just missing ones.
    const response = await request.get('http://localhost:3000/v1/servers', {
      headers: { Authorization: 'Bearer invalid-token-garbage' },
    })
    expect(response.status()).toBe(401)
  })

  test('should login successfully with valid credentials', async ({ page }) => {
    // WHY: Create an isolated test user via Admin API so the test does not
    // depend on a pre-seeded user existing in the database.
    const user = await createTestUser('auth-login')

    await page.goto('/')

    const emailInput = page.locator('[data-test="login-email-input"]')
    await emailInput.fill(user.email)
    await expect(emailInput).toHaveValue(user.email)

    const passwordInput = page.locator('[data-test="login-password-input"]')
    await passwordInput.fill(user.password)
    await expect(passwordInput).toHaveValue(user.password)

    // WHY: Wait for Turnstile to resolve before submitting
    const submitButton = page.locator('[data-test="login-submit-button"]')
    await expect(submitButton).toBeEnabled({ timeout: 10000 })

    const responsePromise = page.waitForResponse((response) =>
      response.url().includes('/auth/v1/token'),
    )

    await submitButton.click()

    const response = await responsePromise
    expect(response.status()).toBeLessThan(400)

    await page.locator('[data-test="main-layout"]').waitFor({ timeout: 15000 })

    await expect(page.locator('[data-test="main-layout"]')).toBeAttached()
    await expect(page.locator('[data-test="login-page"]')).not.toBeVisible()
  })
})
