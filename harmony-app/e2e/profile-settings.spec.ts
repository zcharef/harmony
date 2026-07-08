/**
 * E2E Tests — Profile Settings (display name change)
 *
 * Verifies the P2 identity-polish happy path: the gear button in the user
 * control panel opens the profile settings modal, and a display-name change
 * persists server-side (survives a full page reload).
 *
 * Real data-test attributes from:
 * - channel-sidebar.tsx (user-settings-button)
 * - profile-settings-modal.tsx (profile-settings-modal,
 *   profile-display-name-input, profile-settings-save-button,
 *   profile-settings-cancel-button)
 */
import { expect, test } from '@playwright/test'
import { authenticatePage, selectServer } from './fixtures/auth-fixture'
import { createServer, syncProfile } from './fixtures/test-data-factory'
import { createTestUser, type TestUser } from './fixtures/user-factory'

test.describe('Profile Settings — display name', () => {
  let user: TestUser
  let server: { id: string; name: string }

  test.beforeAll(async () => {
    user = await createTestUser('profset')
    await syncProfile(user.token)
    // WHY a server: without one the app shows the welcome screen, which has
    // no user control panel (and therefore no gear button).
    server = await createServer(user.token, `Profile Settings E2E ${Date.now()}`)
  })

  test('gear button opens the modal and a display name change persists', async ({ page }) => {
    await authenticatePage(page, user)
    await selectServer(page, server.id)

    await page.locator('[data-test="user-settings-button"]').click()
    const modal = page.locator('[data-test="profile-settings-modal"]')
    await modal.waitFor({ timeout: 10_000 })

    const displayNameInput = modal.locator('[data-test="profile-display-name-input"]')
    await displayNameInput.fill('Display Name E2E')
    await modal.locator('[data-test="profile-settings-save-button"]').click()

    // WHY: the modal closes on successful save — this is the success signal.
    await modal.waitFor({ state: 'hidden', timeout: 10_000 })

    // WHY reload: proves the change persisted server-side, not just in the
    // TanStack Query cache. (P3 renders display names across the UI; until
    // then the modal round-trip is the observable contract.)
    await page.reload()
    await page.locator('[data-test="main-layout"]').waitFor({ timeout: 15_000 })

    await page.locator('[data-test="user-settings-button"]').click()
    await expect(
      page.locator('[data-test="profile-settings-modal"] [data-test="profile-display-name-input"]'),
    ).toHaveValue('Display Name E2E', { timeout: 10_000 })
  })

  test('cancel closes the modal without saving', async ({ page }) => {
    await authenticatePage(page, user)
    await selectServer(page, server.id)

    await page.locator('[data-test="user-settings-button"]').click()
    const modal = page.locator('[data-test="profile-settings-modal"]')
    await modal.waitFor({ timeout: 10_000 })

    await modal.locator('[data-test="profile-display-name-input"]').fill('Never Saved')
    await modal.locator('[data-test="profile-settings-cancel-button"]').click()
    await modal.waitFor({ state: 'hidden', timeout: 10_000 })

    // Reopen: the discarded edit must not be there.
    await page.locator('[data-test="user-settings-button"]').click()
    await expect(
      page.locator('[data-test="profile-settings-modal"] [data-test="profile-display-name-input"]'),
    ).not.toHaveValue('Never Saved', { timeout: 10_000 })
  })
})
