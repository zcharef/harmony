import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 2,
  retries: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:1420',
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    // WHY: Traces and screenshots capture what the page actually shows on failure.
    // Without these, we only see "element not found" with no visual evidence.
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
})
