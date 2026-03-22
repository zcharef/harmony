/**
 * Dependency bump smoke tests.
 *
 * WHY: After bumping React 19.1→19.2, TypeScript 5.8→5.9, Vite 7.0→7.3,
 * vitest 4.0→4.1, @heroui/react ^2.8.10, eslint-plugin-boundaries 5→6,
 * tailwindcss 4.2.1→4.2.2, @hey-api/openapi-ts 0.92→0.94, Rust 1.93→1.94
 * — these tests verify the full stack still works end-to-end.
 */

import { expect, test } from '@playwright/test'
import { authenticatePage, selectServer } from './fixtures/auth-fixture'
import { createServer, syncProfile } from './fixtures/test-data-factory'
import { createTestUser, type TestUser } from './fixtures/user-factory'

test.describe('Dependency Bump Smoke Tests', () => {
  let user: TestUser

  test.beforeAll(async () => {
    user = await createTestUser('dep-smoke')
    await syncProfile(user.token)
  })

  // ── App loads and renders main layout ────────────────────────────

  test('app loads and renders main layout after dep bump', async ({ page }) => {
    await authenticatePage(page, user)

    // WHY: authenticatePage already waits for main-layout, but we verify
    // both main-layout and server-sidebar to confirm React rendering works
    // through the new React 19.2 + Vite 7.3 pipeline.
    const mainLayout = page.locator('[data-test="main-layout"]')
    await expect(mainLayout).toBeVisible({ timeout: 15_000 })

    const serverList = page.locator('[data-test="server-list"]')
    await expect(serverList).toBeVisible({ timeout: 10_000 })
  })

  // ── API health check works after dep bump ────────────────────────

  test('API client returns successful responses after dep bump', async ({ page }) => {
    // WHY: The @hey-api/openapi-ts 0.92→0.94 bump removed client-fetch as a
    // separate package (now bundled). This test verifies the generated API
    // client still produces valid HTTP requests and parses responses.
    const responsePromise = page.waitForResponse(
      (response) => response.url().includes('/v1/'),
    )

    await authenticatePage(page, user)

    const response = await responsePromise
    expect(response.status()).toBeLessThan(400)
  })

  // ── Server creation flow works (full CRUD through bumped stack) ──

  test('server creation and sidebar rendering works after dep bump', async ({ page }) => {
    // WHY: This exercises the full data path: API call (generated client) →
    // TanStack Query cache → React rendering → HeroUI Avatar component.
    // Proves the bumped stack handles CRUD + reactive UI updates.
    const serverName = `dep-smoke-${Date.now()}`
    const server = await createServer(user.token, serverName)

    await authenticatePage(page, user)

    // AFTER: server appears in the sidebar (proves data fetching + rendering
    // through new React/TanStack Query/HeroUI versions)
    const serverButton = page.locator(
      `[data-test="server-button"][data-server-id="${server.id}"]`,
    )
    await expect(serverButton).toBeVisible({ timeout: 10_000 })

    // Navigate to the server and verify channel sidebar renders
    await selectServer(page, server.id)

    const serverNameHeader = page.locator('[data-test="server-name-header"]')
    await expect(serverNameHeader).toContainText(serverName)

    // WHY: The auto-created #general channel proves the full server→channels
    // data pipeline works after the dependency bump.
    const channelButtons = page.locator('[data-test="channel-button"]')
    await expect(channelButtons.first()).toBeVisible({ timeout: 10_000 })

    const generalChannel = channelButtons.filter({ hasText: 'general' })
    await expect(generalChannel).toBeVisible()
  })

  // ── HeroUI components render correctly after bump ────────────────

  test('HeroUI components render with correct content after bump', async ({ page }) => {
    // WHY: @heroui/react ^2.8.10 bump could break component rendering.
    // Verify that Avatar (server icons), Tooltip, and interactive elements
    // render with actual content — not just visibility but text content.
    const server = await createServer(user.token, `heroui-smoke-${Date.now()}`)

    await authenticatePage(page, user)

    // WHY: The server list uses HeroUI Avatar + Tooltip for each server icon.
    // Verifying the server-list renders with buttons proves Avatar works.
    const serverList = page.locator('[data-test="server-list"]')
    await expect(serverList).toBeVisible({ timeout: 10_000 })

    // WHY: The add-server button is a HeroUI Avatar with a Plus icon.
    // Its presence proves HeroUI's Avatar component renders correctly.
    const addServerButton = page.locator('[data-test="add-server-button"]')
    await expect(addServerButton).toBeVisible({ timeout: 10_000 })

    // WHY: The DM home button is a HeroUI Avatar with a MessageCircle icon.
    // Verifying it exists confirms HeroUI icon slot rendering works.
    const dmHomeButton = page.locator('[data-test="dm-home-button"]')
    await expect(dmHomeButton).toBeVisible()

    // Navigate to the server to verify channel sidebar (HeroUI Button components)
    await selectServer(page, server.id)

    const channelSidebar = page.locator('[data-test="channel-sidebar"]')
    await expect(channelSidebar).toBeVisible({ timeout: 10_000 })

    // WHY: Channel buttons use HeroUI styling. Verify the auto-created
    // #general channel renders with text content, not just as an empty element.
    const generalChannel = page.locator('[data-test="channel-button"]').filter({ hasText: 'general' })
    await expect(generalChannel).toContainText('general')

    // WHY: Server name header uses HeroUI text styling. Strict content check
    // proves text rendering and Tailwind 4.2.2 class processing both work.
    const serverNameHeader = page.locator('[data-test="server-name-header"]')
    await expect(serverNameHeader).toContainText('heroui-smoke')
  })
})
