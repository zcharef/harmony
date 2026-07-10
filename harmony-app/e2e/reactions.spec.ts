import { expect, test } from '@playwright/test'
import { authenticatePage, selectChannel, selectServer } from './fixtures/auth-fixture'
import {
  addReaction,
  createInvite,
  createServer,
  getServerChannels,
  joinServer,
  sendMessage,
  syncProfile,
} from './fixtures/test-data-factory'
import { createTestUser, type TestUser } from './fixtures/user-factory'

/**
 * "Who reacted" tooltip E2E (T1.5).
 *
 * The reactor list rides the message payload and is patched live by the
 * reaction.added / reaction.removed SSE events — never a separate fetch. All
 * reactions are seeded through the real API (never mocked).
 */
test.describe('Reactions — who reacted', () => {
  let owner: TestUser
  let alice: TestUser
  let bob: TestUser
  let server: { id: string; name: string }
  let channelId: string

  test.beforeAll(async () => {
    // The prefix becomes each user's display_name — asserted in the tooltip.
    owner = await createTestUser('who-owner')
    alice = await createTestUser('who-alice')
    bob = await createTestUser('who-bob')
    await syncProfile(owner.token)
    await syncProfile(alice.token)
    await syncProfile(bob.token)

    server = await createServer(owner.token, `who-test-${Date.now()}`)
    const channelList = await getServerChannels(owner.token, server.id)
    const gen = channelList.items.find((c) => c.name === 'general')
    if (gen === undefined) {
      throw new Error('Expected #general channel to exist after server creation')
    }
    channelId = gen.id

    const invite = await createInvite(owner.token, server.id)
    await joinServer(alice.token, server.id, invite.code)
    await joinServer(bob.token, server.id, invite.code)
  })

  test('hovering a reaction pill shows the reactor display name', async ({ page }) => {
    const msg = await sendMessage(owner.token, channelId, 'hover to see who reacted')
    await addReaction(alice.token, channelId, msg.id, '👍')

    await authenticatePage(page, owner)
    await selectServer(page, server.id)
    await selectChannel(page, 'general')

    const messageItem = page.locator(`[data-test="message-item"][data-message-id="${msg.id}"]`)
    await expect(messageItem).toBeVisible({ timeout: 10_000 })

    const pill = messageItem.locator('[data-test="reaction-pill"]')
    await expect(pill).toBeVisible({ timeout: 10_000 })
    await pill.hover()

    // The tooltip lists Alice's display name.
    await expect(page.getByRole('tooltip')).toContainText('who-alice', { timeout: 5_000 })
  })

  test('a live reaction updates the tooltip without a refresh', async ({ page }) => {
    const msg = await sendMessage(owner.token, channelId, 'live update target')
    await addReaction(alice.token, channelId, msg.id, '🎉')

    await authenticatePage(page, owner)
    await selectServer(page, server.id)
    await selectChannel(page, 'general')

    const messageItem = page.locator(`[data-test="message-item"][data-message-id="${msg.id}"]`)
    const pill = messageItem.locator('[data-test="reaction-pill"]')
    await expect(pill).toBeVisible({ timeout: 10_000 })
    // Starts at a single reactor.
    await expect(pill).toContainText('1')

    // Bob reacts from another session — the SSE event patches the cache live.
    await addReaction(bob.token, channelId, msg.id, '🎉')
    await expect(pill).toContainText('2', { timeout: 10_000 })

    await pill.hover()
    const tooltip = page.getByRole('tooltip')
    await expect(tooltip).toContainText('who-alice', { timeout: 5_000 })
    await expect(tooltip).toContainText('who-bob')
  })

  test('overflow shows "+N others" beyond the first ten reactors', async ({ page }) => {
    const msg = await sendMessage(owner.token, channelId, 'overflow target')

    // 12 distinct reactors → the server caps the list at 10 and the tooltip
    // renders "+2 others".
    const reactors: TestUser[] = []
    for (let i = 0; i < 12; i++) {
      const u = await createTestUser(`who-many-${i}`)
      await syncProfile(u.token)
      await joinServer(u.token, server.id, (await createInvite(owner.token, server.id)).code)
      await addReaction(u.token, channelId, msg.id, '🔥')
      reactors.push(u)
    }

    await authenticatePage(page, owner)
    await selectServer(page, server.id)
    await selectChannel(page, 'general')

    const messageItem = page.locator(`[data-test="message-item"][data-message-id="${msg.id}"]`)
    const pill = messageItem.locator('[data-test="reaction-pill"]')
    await expect(pill).toBeVisible({ timeout: 10_000 })
    await expect(pill).toContainText('12')

    await pill.hover()
    await expect(page.getByRole('tooltip')).toContainText('+2 others', { timeout: 5_000 })
  })

  test('keyboard focus opens the tooltip (a11y)', async ({ page }) => {
    const msg = await sendMessage(owner.token, channelId, 'keyboard focus target')
    await addReaction(alice.token, channelId, msg.id, '👀')

    await authenticatePage(page, owner)
    await selectServer(page, server.id)
    await selectChannel(page, 'general')

    const messageItem = page.locator(`[data-test="message-item"][data-message-id="${msg.id}"]`)
    const pill = messageItem.locator('[data-test="reaction-pill"]')
    await expect(pill).toBeVisible({ timeout: 10_000 })

    // Focusing the pill (a real <button>) opens the HeroUI tooltip.
    await pill.focus()
    await expect(page.getByRole('tooltip')).toContainText('who-alice', { timeout: 5_000 })
  })
})
