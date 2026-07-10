import { expect, test } from '@playwright/test'
import { authenticatePage } from './fixtures/auth-fixture'
import { createInvite, createServer, syncProfile } from './fixtures/test-data-factory'
import { createTestUser, type TestUser } from './fixtures/user-factory'

/**
 * Invite landing page (/invite/:code) — the referral loop's activation
 * surface. Server context BEFORE signup, account creation AFTER intent.
 */
test.describe('Invite landing page', () => {
  let owner: TestUser
  let server: { id: string; name: string }
  let inviteCode: string

  test.beforeAll(async () => {
    owner = await createTestUser('invland-owner')
    await syncProfile(owner.token)
    server = await createServer(owner.token, `invland-${Date.now()}`)
    const invite = await createInvite(owner.token, server.id)
    inviteCode = invite.code
  })

  test('cold (unauthenticated) browser sees server context before any signup', async ({ page }) => {
    await page.goto(`/invite/${inviteCode}`)

    const card = page.locator('[data-test="invite-landing-page"]')
    await expect(card).toBeVisible({ timeout: 10_000 })

    await expect(page.locator('[data-test="invite-server-name"]')).toHaveText(server.name, {
      timeout: 10_000,
    })
    await expect(page.locator('[data-test="invite-member-count"]')).toContainText('member')
    await expect(page.locator('[data-test="invite-accept-button"]')).toBeVisible()
  })

  test('accept while unauthenticated escalates to the auth screen, URL preserved', async ({
    page,
  }) => {
    await page.goto(`/invite/${inviteCode}`)

    await page.locator('[data-test="invite-accept-button"]').click()

    // The login/signup form appears while the invite URL is preserved so the
    // flow can resume post-auth.
    await expect(page.locator('form')).toBeVisible({ timeout: 10_000 })
    expect(new URL(page.url()).pathname).toBe(`/invite/${inviteCode}`)
  })

  test('authenticated user lands IN the server after accepting', async ({ page }) => {
    const joiner = await createTestUser('invland-joiner')
    await syncProfile(joiner.token)
    await authenticatePage(page, joiner)

    await page.goto(`/invite/${inviteCode}`)

    const accept = page.locator('[data-test="invite-accept-button"]')
    await expect(accept).toBeVisible({ timeout: 10_000 })
    await accept.click()

    // The flow finishes into the main shell with the joined server selected.
    await expect(page.locator('[data-test="main-layout"]')).toBeVisible({ timeout: 15_000 })
    await expect(page).toHaveURL('/', { timeout: 10_000 })
    // Channel sidebar visible = a server is selected and its channels loaded.
    await expect(page.locator('[data-test="channel-sidebar"]')).toBeVisible({ timeout: 10_000 })
  })

  test('dead or unknown invite shows the invalid state, not a login wall', async ({ page }) => {
    await page.goto('/invite/doesNotExist00')

    await expect(page.locator('[data-test="invite-invalid"]')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('[data-test="invite-continue-button"]')).toBeVisible()
  })
})
