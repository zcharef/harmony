import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	testDir: "./e2e",
	fullyParallel: false,
	retries: 1,
	timeout: 30_000,
	expect: { timeout: 10_000 },
	reporter: "html",
	use: {
		baseURL: "http://localhost:1420",
		...devices["Desktop Chrome"],
		viewport: { width: 1440, height: 900 },
	},
});
