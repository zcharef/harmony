import { type Page, expect, test } from "@playwright/test";

test.describe("Authentication", () => {
	test("should render login page with all required elements", async ({
		page,
	}) => {
		await page.goto("/");

		const heading = page.locator('[data-test="login-heading"]');
		await expect(heading).toHaveText(/Harmony/);

		const subtitle = page.locator('[data-test="login-subtitle"]');
		await expect(subtitle).toHaveText(/Welcome back!/);

		const emailInput = page.locator('[data-test="login-email-input"]');
		await expect(emailInput).toBeAttached();

		const passwordInput = page.locator(
			'[data-test="login-password-input"]',
		);
		await expect(passwordInput).toBeAttached();

		const submitButton = page.locator('[data-test="login-submit-button"]');
		await expect(submitButton).toHaveText(/Sign In/);

		const toggleButton = page.locator('[data-test="login-toggle-button"]');
		await expect(toggleButton).toHaveText(/Sign up/i);
	});

	test("should toggle between login and signup modes", async ({ page }) => {
		await page.goto("/");

		const subtitle = page.locator('[data-test="login-subtitle"]');
		await expect(subtitle).toHaveText(/Welcome back!/);

		const toggleButton = page.locator('[data-test="login-toggle-button"]');
		await toggleButton.click();

		await expect(subtitle).toHaveText(/Create your account/);

		const submitButton = page.locator('[data-test="login-submit-button"]');
		await expect(submitButton).toHaveText(/Sign Up/);

		await toggleButton.click();

		await expect(subtitle).toHaveText(/Welcome back!/);
	});

	test("should show error message for invalid credentials", async ({
		page,
	}) => {
		await page.goto("/");

		const emailInput = page.locator('[data-test="login-email-input"]');
		await emailInput.fill("bad@test.com");
		await expect(emailInput).toHaveValue("bad@test.com");

		const passwordInput = page.locator(
			'[data-test="login-password-input"]',
		);
		await passwordInput.fill("wrongpass");
		await expect(passwordInput).toHaveValue("wrongpass");

		await page.locator('[data-test="login-submit-button"]').click();

		await page.waitForTimeout(2000);

		const errorMessage = page.locator('[data-test="login-error-message"]');
		await expect(errorMessage).toBeAttached();
		await expect(errorMessage).not.toHaveText("");
	});

	test("should login successfully with valid credentials", async ({
		page,
	}) => {
		await page.goto("/");

		const emailInput = page.locator('[data-test="login-email-input"]');
		await emailInput.fill("alice@harmony.test");
		await expect(emailInput).toHaveValue("alice@harmony.test");

		const passwordInput = page.locator(
			'[data-test="login-password-input"]',
		);
		await passwordInput.fill("password123");
		await expect(passwordInput).toHaveValue("password123");

		const responsePromise = page.waitForResponse((response) =>
			response.url().includes("/auth/v1/token"),
		);

		await page.locator('[data-test="login-submit-button"]').click();

		const response = await responsePromise;
		expect(response.status()).toBeLessThan(400);

		await page
			.locator('[data-test="main-layout"]')
			.waitFor({ timeout: 15000 });

		await expect(page.locator('[data-test="main-layout"]')).toBeAttached();
		await expect(page.locator('[data-test="login-page"]')).not.toBeVisible();
	});
});
