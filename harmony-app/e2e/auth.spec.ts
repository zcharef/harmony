import { expect, test } from '@playwright/test'

test.describe('Authentication', () => {
  test('should render login page with all required elements', async ({ page }) => {
    await page.goto('/')

    const heading = page.locator('[data-test="login-heading"]')
    await expect(heading).toHaveText(/Harmony/)

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

    // All three requirement indicators should be visible
    await expect(page.getByText('At least 8 characters')).toBeVisible()
    await expect(page.getByText('Contains a letter')).toBeVisible()
    await expect(page.getByText('Contains a number')).toBeVisible()

    // 'a' satisfies letter but not length or digit
    // WHY: CircleCheck for met requirements uses text-success, CircleX for unmet uses text-default-400.
    // We verify the correct icon is rendered via the SVG's CSS class.
    const letterRow = page.getByText('Contains a letter').locator('..')
    await expect(letterRow.locator('.text-success')).toBeAttached()

    const lengthRow = page.getByText('At least 8 characters').locator('..')
    await expect(lengthRow.locator('.text-default-400')).toBeAttached()

    const digitRow = page.getByText('Contains a number').locator('..')
    await expect(digitRow.locator('.text-default-400')).toBeAttached()

    // Satisfy all requirements
    await passwordInput.fill('abcdefg1')

    await expect(lengthRow.locator('.text-success')).toBeAttached()
    await expect(letterRow.locator('.text-success')).toBeAttached()
    await expect(digitRow.locator('.text-success')).toBeAttached()
  })

  test('should not show password hints on login mode', async ({ page }) => {
    await page.goto('/')

    const passwordInput = page.locator('[data-test="login-password-input"]')
    await passwordInput.fill('short')

    // Hints should NOT appear in login mode
    await expect(page.getByText('At least 8 characters')).not.toBeVisible()
  })

  test('should disable signup button when password is invalid', async ({ page }) => {
    await page.goto('/')

    // Switch to signup mode
    const toggleButton = page.locator('[data-test="login-toggle-button"]')
    await toggleButton.click()

    const usernameInput = page.locator('[data-test="login-username-input"]')
    await usernameInput.fill('validuser')

    const emailInput = page.locator('[data-test="login-email-input"]')
    await emailInput.fill('test@example.com')

    const passwordInput = page.locator('[data-test="login-password-input"]')
    await passwordInput.fill('short')

    // WHY: Even after captcha resolves, button stays disabled with an invalid password
    const submitButton = page.locator('[data-test="login-submit-button"]')
    await expect(submitButton).toBeDisabled()

    // Satisfy password requirements
    await passwordInput.fill('validpass1')

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

  test('should login successfully with valid credentials', async ({ page }) => {
    await page.goto('/')

    const emailInput = page.locator('[data-test="login-email-input"]')
    await emailInput.fill('alice@harmony.test')
    await expect(emailInput).toHaveValue('alice@harmony.test')

    const passwordInput = page.locator('[data-test="login-password-input"]')
    await passwordInput.fill('password123')
    await expect(passwordInput).toHaveValue('password123')

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
