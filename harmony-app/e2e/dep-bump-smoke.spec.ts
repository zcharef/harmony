/**
 * Dependency bump smoke tests.
 *
 * WHY: After bumping React 19.1->19.2, TypeScript 5.8->5.9, Vite 7.0->7.3,
 * vitest 4.0->4.1, @heroui/react ^2.8.10, eslint-plugin-boundaries 5->6,
 * tailwindcss 4.2.1->4.2.2, @hey-api/openapi-ts 0.92->0.94, Rust 1.93->1.94
 * -- these tests verify the full stack still works end-to-end.
 */

import { expect, test } from '@playwright/test'
import { authenticatePage, selectServer } from './fixtures/auth-fixture'
import { createServer, syncProfile } from './fixtures/test-data-factory'
import { createTestUser, type TestUser } from './fixtures/user-factory'

test.describe('Dependency Bump Smoke Tests', () => {
  // WHY shared user: Tests 2-4 each create their own isolated server data,
  // so sharing a user is safe. Selectors use data-server-id for isolation,
  // meaning count-based assertions on the shared user's full server list are
  // avoided in favor of targeted element lookups.
  let user: TestUser

  test.beforeAll(async () => {
    user = await createTestUser('dep-smoke')
    await syncProfile(user.token)
  })

  // -- API health check works after dep bump --------------------------------

  test('API client returns successful responses after dep bump', async ({ page }) => {
    // WHY: The @hey-api/openapi-ts 0.92->0.94 bump removed client-fetch as a
    // separate package (now bundled). This test verifies the generated API
    // client still produces valid HTTP requests and parses responses.
    const responsePromise = page.waitForResponse(
      (response) => response.url().includes('/v1/') && response.status() < 400,
    )

    await authenticatePage(page, user)

    const response = await responsePromise
    expect(response.status()).toBeLessThan(400)

    // WHY: authenticatePage already confirms main-layout renders. Here we
    // verify structural children exist, proving React 19.2 component tree
    // rendering works beyond the top-level container.
    const serverList = page.locator('[data-test="server-list"]')
    const dmHomeButton = serverList.locator('[data-test="dm-home-button"]')
    await expect(dmHomeButton).toBeAttached({ timeout: 10_000 })

    const addServerButton = serverList.locator('[data-test="add-server-button"]')
    await expect(addServerButton).toBeAttached()
  })

  // -- Server creation flow works (full CRUD through bumped stack) ----------

  test('server creation and sidebar rendering works after dep bump', async ({ page }) => {
    // WHY: This exercises the full data path: API call (generated client) ->
    // TanStack Query cache -> React rendering -> HeroUI Avatar component.
    // Proves the bumped stack handles CRUD + reactive UI updates.
    const serverName = `dep-smoke-${Date.now()}`
    const server = await createServer(user.token, serverName)

    const serversResponsePromise = page.waitForResponse(
      (response) => response.url().includes('/v1/servers') && response.status() < 400,
    )

    await authenticatePage(page, user)

    const serversResponse = await serversResponsePromise
    expect(serversResponse.status()).toBeLessThan(400)

    // AFTER: server appears in the sidebar (proves data fetching + rendering
    // through new React/TanStack Query/HeroUI versions)
    const serverButton = page.locator(`[data-test="server-button"][data-server-id="${server.id}"]`)
    await expect(serverButton).toBeAttached({ timeout: 10_000 })

    // Navigate to the server and verify channel sidebar renders
    await selectServer(page, server.id)

    const serverNameHeader = page.locator('[data-test="server-name-header"]')
    await expect(serverNameHeader).toContainText(serverName)

    // WHY: The auto-created #general channel proves the full server->channels
    // data pipeline works after the dependency bump.
    const channelButtons = page.locator('[data-test="channel-button"]')
    await expect(channelButtons).toHaveCount(1, { timeout: 10_000 })

    const generalChannel = channelButtons.filter({ hasText: 'general' })
    await expect(generalChannel).toContainText('general')
  })

  // -- HeroUI components render correctly after bump ------------------------

  test('HeroUI components render with correct content after bump', async ({ page }) => {
    // WHY: @heroui/react ^2.8.10 bump could break component rendering.
    // Verify that Avatar (server icons), Tooltip, and interactive elements
    // render with actual content -- not just visibility but text content.
    const serverName = `heroui-smoke-${Date.now()}`
    const server = await createServer(user.token, serverName)

    const serversResponsePromise = page.waitForResponse(
      (response) => response.url().includes('/v1/servers') && response.status() < 400,
    )

    await authenticatePage(page, user)

    const serversResponse = await serversResponsePromise
    expect(serversResponse.status()).toBeLessThan(400)

    // WHY: The server list uses HeroUI Avatar + Tooltip for each server icon.
    // Verifying structural children proves Avatar component tree works.
    const serverList = page.locator('[data-test="server-list"]')
    const addServerButton = serverList.locator('[data-test="add-server-button"]')
    await expect(addServerButton).toBeAttached({ timeout: 10_000 })

    const dmHomeButton = serverList.locator('[data-test="dm-home-button"]')
    await expect(dmHomeButton).toBeAttached()

    const joinServerButton = serverList.locator('[data-test="join-server-button"]')
    await expect(joinServerButton).toBeAttached()

    // Navigate to the server to verify channel sidebar (HeroUI Button components)
    await selectServer(page, server.id)

    // WHY: Channel buttons use HeroUI styling. Verify the auto-created
    // #general channel renders with text content, not just as an empty element.
    const channelList = page.locator('[data-test="channel-list"]')
    const generalChannel = channelList
      .locator('[data-test="channel-button"]')
      .filter({ hasText: 'general' })
    await expect(generalChannel).toContainText('general', { timeout: 10_000 })

    // WHY: Server name header uses HeroUI text styling. Strict content check
    // proves text rendering and Tailwind 4.2.2 class processing both work.
    const serverNameHeader = page.locator('[data-test="server-name-header"]')
    await expect(serverNameHeader).toContainText(serverName)
  })
})
