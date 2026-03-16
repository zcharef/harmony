import { type Page, expect, test } from "@playwright/test";

async function loginAsAlice(page: Page) {
	await page.goto("/");
	await page
		.locator('[data-test="login-email-input"]')
		.fill("alice@harmony.test");
	await page
		.locator('[data-test="login-password-input"]')
		.fill("password123");
	await page.locator('[data-test="login-submit-button"]').click();
	await page
		.locator('[data-test="main-layout"]')
		.waitFor({ timeout: 15000 });
}

test.describe("Create Server", () => {
	test.beforeEach(async ({ page }) => {
		await loginAsAlice(page);
	});

	test("should create a new server and verify it appears in server list", async ({
		page,
	}) => {
		const serverName = `E2E Server ${Date.now()}`;

		await page.locator('[data-test="add-server-button"]').click();

		const dialog = page.locator('[data-test="create-server-dialog"]');
		await dialog.waitFor({ timeout: 10000 });
		await expect(dialog).toBeVisible();

		const nameInput = page.locator('[data-test="server-name-input"]');
		await nameInput.fill(serverName);
		await expect(nameInput).toHaveValue(serverName);

		const responsePromise = page.waitForResponse(
			(response) =>
				response.url().includes("/v1/servers") &&
				response.request().method() === "POST",
		);

		await page.locator('[data-test="create-server-submit-button"]').click();

		const response = await responsePromise;
		expect(response.status()).toBeLessThan(400);

		const body = await response.json();
		const serverId = body.id as string;

		await expect(dialog).not.toBeVisible();

		const newServerButton = page.locator(
			`[data-test="server-button"][data-server-id="${serverId}"]`,
		);
		await newServerButton.waitFor({ timeout: 10000 });
		await expect(newServerButton).toBeAttached();

		await newServerButton.click();

		const channelSidebar = page.locator('[data-test="channel-sidebar"]');
		await channelSidebar.waitFor({ timeout: 10000 });
		await expect(channelSidebar).toBeAttached();

		const serverNameHeader = page.locator(
			'[data-test="server-name-header"]',
		);
		await expect(serverNameHeader).toHaveText(new RegExp(serverName));
	});
});
