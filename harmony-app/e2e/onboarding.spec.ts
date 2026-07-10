import { expect, type Page, test } from '@playwright/test'
import { authenticatePage } from './fixtures/auth-fixture'
import {
  createInvite,
  createServer,
  getServerChannels,
  joinServer,
  syncProfile,
  updateChannel,
} from './fixtures/test-data-factory'
import { createTestUser, type TestUser } from './fixtures/user-factory'

/**
 * Onboarding first-run flow — ticket §7 named scenarios.
 *
 * WHY per-test users: onboarding is a one-shot flag. Sharing a user across
 * tests would make later tests depend on earlier completion state.
 *
 * The official-server scenarios need VITE_OFFICIAL_SERVER_ID (and the API's
 * matching OFFICIAL_SERVER_ID + auto-join). They skip when the env is unset —
 * same conditional pattern as channel-voice-scope.spec.ts (LiveKit).
 */

const OFFICIAL_SERVER_ID = process.env.VITE_OFFICIAL_SERVER_ID

async function newFirstRunUser(prefix: string): Promise<TestUser> {
  const user = await createTestUser(prefix)
  await syncProfile(user.token)
  return user
}

/** Waits for the completion PATCH so a reload cannot race the flag write. */
function waitForCompletionPatch(page: Page) {
  return page.waitForResponse(
    (response) =>
      response.url().includes('/v1/preferences') && response.request().method() === 'PATCH',
  )
}

test.describe('Onboarding first-run flow', () => {
  // ── onboarding-first-run-appears ────────────────────────────────

  test('onboarding-first-run-appears: fresh signup sees the flow, not the welcome screen', async ({
    page,
  }) => {
    const user = await newFirstRunUser('onb-appear')
    await authenticatePage(page, user, { firstRun: true })

    await expect(page.locator('[data-test="onboarding-flow"]')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('[data-test="welcome-screen"]')).toHaveCount(0)
  })

  // ── onboarding-skip-completes ───────────────────────────────────

  test('onboarding-skip-completes: skipping through persists the flag across reloads', async ({
    page,
  }) => {
    const user = await newFirstRunUser('onb-skip')
    await authenticatePage(page, user, { firstRun: true })

    const flow = page.locator('[data-test="onboarding-flow"]')
    await expect(flow).toBeVisible({ timeout: 10_000 })

    // Step 1 → 2 → 3 → Done.
    await page.locator('[data-test="onboarding-next"]').click()
    await page.locator('[data-test="onboarding-skip"]').click()

    const patchPromise = waitForCompletionPatch(page)
    await page.locator('[data-test="onboarding-done"]').click()
    const patch = await patchPromise
    expect(patch.status()).toBeLessThan(400)

    // Flow gone; with zero custom servers the re-scoped welcome screen shows.
    await expect(flow).toHaveCount(0)
    await expect(page.locator('[data-test="welcome-screen"]')).toBeVisible({ timeout: 10_000 })

    // Reload: the flag is server-persisted — the flow must NOT reappear.
    await page.reload()
    await page.locator('[data-test="main-layout"]').waitFor({ timeout: 15_000 })
    await expect(page.locator('[data-test="welcome-screen"]')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('[data-test="onboarding-flow"]')).toHaveCount(0)
  })

  // ── onboarding-create-server-path ───────────────────────────────

  test('onboarding-create-server-path: creating a server completes the flow and selects it', async ({
    page,
  }) => {
    const user = await newFirstRunUser('onb-create')
    await authenticatePage(page, user, { firstRun: true })

    await expect(page.locator('[data-test="onboarding-flow"]')).toBeVisible({ timeout: 10_000 })
    await page.locator('[data-test="onboarding-next"]').click()
    await page.locator('[data-test="onboarding-create-card"]').click()

    const dialog = page.locator('[data-test="create-server-dialog"]')
    await expect(dialog).toBeVisible({ timeout: 5_000 })
    await page.locator('[data-test="server-name-input"]').fill(`Onboarded ${Date.now()}`)

    const createPromise = page.waitForResponse(
      (response) =>
        response.url().includes('/v1/servers') && response.request().method() === 'POST',
    )
    const patchPromise = waitForCompletionPatch(page)
    await page.locator('[data-test="create-server-submit-button"]').click()
    const createRes = await createPromise
    expect(createRes.status()).toBeLessThan(400)
    const created = (await createRes.json()) as { id: string }
    expect((await patchPromise).status()).toBeLessThan(400)

    // Flow completes, the new server is selected, its channel list is visible.
    await expect(page.locator('[data-test="onboarding-flow"]')).toHaveCount(0)
    await expect(
      page.locator(`[data-test="server-button"][data-server-id="${created.id}"]`),
    ).toBeVisible({ timeout: 10_000 })
    await expect(
      page.locator('[data-test="channel-list"] [data-test="channel-button"]').first(),
    ).toBeVisible({ timeout: 15_000 })
  })

  // ── rail click wins over the flow (regression, review finding) ──

  test('clicking a server in the rail during onboarding completes the flow and navigates', async ({
    page,
  }) => {
    // WHY: a rail click is an explicit navigation — it must win over the flow
    // (complete + navigate, like the explore CTA), never be silently swallowed.
    const owner = await createTestUser('onb-rail-owner')
    await syncProfile(owner.token)
    const server = await createServer(owner.token, `Rail ${Date.now()}`)
    const invite = await createInvite(owner.token, server.id)

    const member = await newFirstRunUser('onb-rail-member')
    await joinServer(member.token, server.id, invite.code)

    await authenticatePage(page, member, { firstRun: true })
    await expect(page.locator('[data-test="onboarding-flow"]')).toBeVisible({ timeout: 10_000 })

    const patchPromise = waitForCompletionPatch(page)
    await page.locator(`[data-test="server-button"][data-server-id="${server.id}"]`).click()
    expect((await patchPromise).status()).toBeLessThan(400)

    await expect(page.locator('[data-test="onboarding-flow"]')).toHaveCount(0)
    await expect(
      page.locator('[data-test="channel-list"] [data-test="channel-button"]').first(),
    ).toBeVisible({ timeout: 15_000 })
  })

  // ── returning user never sees the flow ──────────────────────────

  test('returning user (flag already true) does not see the flow', async ({ page }) => {
    // WHY: regression for the fixture default — every non-onboarding spec
    // relies on authenticatePage marking the user as returning
    // (onboardingCompleted=true) BEFORE first load. If that default breaks,
    // fresh fixture users land on the flow and any server-view test that
    // clicks through the rail can deadlock on the remounted rail tooltip.
    const user = await newFirstRunUser('onb-returning-default')
    await authenticatePage(page, user)

    // Zero custom servers + flag true = steady-state welcome screen, no flow.
    await expect(page.locator('[data-test="welcome-screen"]')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('[data-test="onboarding-flow"]')).toHaveCount(0)

    // Reload: still no flow — the flag is server-persisted.
    await page.reload()
    await page.locator('[data-test="main-layout"]').waitFor({ timeout: 15_000 })
    await expect(page.locator('[data-test="welcome-screen"]')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('[data-test="onboarding-flow"]')).toHaveCount(0)
  })

  // ── onboarding-empty-states ─────────────────────────────────────

  test('onboarding-empty-states: channel-less server and empty DM list show polished empty states', async ({
    page,
  }) => {
    // A member of a server whose only channel is private sees zero channels.
    const owner = await createTestUser('onb-empty-owner')
    await syncProfile(owner.token)
    const server = await createServer(owner.token, `Empty ${Date.now()}`)
    const invite = await createInvite(owner.token, server.id)
    // WHY: the last channel cannot be deleted (API guard) — making #general
    // private hides it from plain members instead.
    const channels = await getServerChannels(owner.token, server.id)
    const general = channels.items.find((c) => c.name === 'general')
    if (general === undefined) throw new Error('expected auto-created #general channel')
    await updateChannel(owner.token, server.id, general.id, { isPrivate: true })

    const member = await newFirstRunUser('onb-empty-member')
    await joinServer(member.token, server.id, invite.code)

    await authenticatePage(page, member, { firstRun: true })
    await expect(page.locator('[data-test="onboarding-flow"]')).toBeVisible({ timeout: 10_000 })

    // Rail click completes onboarding and lands in the server (no visible channels).
    await page.locator(`[data-test="server-button"][data-server-id="${server.id}"]`).click()
    await expect(page.locator('[data-test="channel-empty-state"]')).toBeVisible({
      timeout: 10_000,
    })
    // A plain member cannot manage channels — no create CTA.
    await expect(page.locator('[data-test="channel-empty-create-cta"]')).toHaveCount(0)

    // DM view with no conversations shows the start-conversation CTA.
    await page.locator('[data-test="dm-home-button"]').click()
    await expect(page.locator('[data-test="dm-empty-start-cta"]')).toBeVisible({ timeout: 10_000 })
  })
})

// ── Official-server scenarios (need VITE_OFFICIAL_SERVER_ID) ──────

test.describe('Onboarding with official server', () => {
  test.skip(
    OFFICIAL_SERVER_ID === undefined || OFFICIAL_SERVER_ID === '',
    'VITE_OFFICIAL_SERVER_ID not set in this environment',
  )

  // ── onboarding-explore-official ─────────────────────────────────

  test('onboarding-explore-official: the explore CTA completes the flow and opens the official server', async ({
    page,
  }) => {
    // syncProfile triggers the server-side auto-join to the official server.
    const user = await newFirstRunUser('onb-official')
    await authenticatePage(page, user, { firstRun: true })

    // Regression (auto-select fallback): despite being a member of the official
    // server, a first-run user must land on onboarding — never be silently
    // auto-selected into it.
    await expect(page.locator('[data-test="onboarding-flow"]')).toBeVisible({ timeout: 10_000 })

    const explore = page.locator('[data-test="onboarding-explore-official"]')
    await expect(explore).toBeVisible()

    const patchPromise = waitForCompletionPatch(page)
    await explore.click()
    expect((await patchPromise).status()).toBeLessThan(400)

    await expect(page.locator('[data-test="onboarding-flow"]')).toHaveCount(0)
    // Regression (showWelcome yields to explicit selection): the user has zero
    // custom servers, yet the explicit navigation must show the official
    // server's channels, not the welcome empty state.
    await expect(page.locator('[data-test="welcome-screen"]')).toHaveCount(0)
    await expect(
      page.locator('[data-test="channel-list"] [data-test="channel-button"]').first(),
    ).toBeVisible({ timeout: 15_000 })
  })

  // ── returning official-only user (regression for both §1.1 fixes) ──

  test('returning official-only user lands on welcome, and a rail click opens the official server', async ({
    page,
  }) => {
    const user = await newFirstRunUser('onb-returning')
    // Already onboarded — the default fixture marks the user as returning.
    await authenticatePage(page, user)

    // Regression (auto-select fallback = userServers[0], official excluded):
    // with no custom servers and no saved position, the user must land on the
    // welcome empty state — not be silently dropped inside the official server.
    await expect(page.locator('[data-test="welcome-screen"]')).toBeVisible({ timeout: 10_000 })

    // Regression (showWelcome yields to explicit selection): clicking the
    // official server in the rail must replace the welcome screen with the
    // server's channels — before the fix this click was unreachable state.
    await page
      .locator(`[data-test="server-button"][data-server-id="${OFFICIAL_SERVER_ID}"]`)
      .click()
    await expect(page.locator('[data-test="welcome-screen"]')).toHaveCount(0)
    await expect(
      page.locator('[data-test="channel-list"] [data-test="channel-button"]').first(),
    ).toBeVisible({ timeout: 15_000 })
  })
})
