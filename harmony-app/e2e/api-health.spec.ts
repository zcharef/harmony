import { expect, test } from "@playwright/test";

const API_BASE = "http://localhost:3000";

test.describe("API Health", () => {
	test("should return 200 on health endpoint", async ({ page }) => {
		const status = await page.evaluate(async (baseUrl) => {
			const res = await fetch(`${baseUrl}/health`);
			return res.status;
		}, API_BASE);

		expect(status).toBe(200);
	});

	test("should return 401 on /v1/servers without auth", async ({ page }) => {
		const status = await page.evaluate(async (baseUrl) => {
			const res = await fetch(`${baseUrl}/v1/servers`);
			return res.status;
		}, API_BASE);

		expect(status).toBe(401);
	});

	test("should return 401 on /v1/channels messages without auth", async ({
		page,
	}) => {
		const status = await page.evaluate(async (baseUrl) => {
			const res = await fetch(
				`${baseUrl}/v1/channels/dddddddd-dddd-dddd-dddd-dddddddddddd/messages`,
			);
			return res.status;
		}, API_BASE);

		expect(status).toBe(401);
	});
});
