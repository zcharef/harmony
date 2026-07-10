/**
 * E2E Tests — "New messages" divider + jump-to-message (unread-divider ticket §7.4).
 *
 * Drives the real Rust API + local Supabase (never mocked). Covers the named
 * scenarios whose data-test hooks ship in chat-area.tsx / message-item.tsx:
 *   - unread-divider-appears-on-open : an unread reader sees the red divider.
 *   - divider-frozen-while-reading   : it stays put after mark-read fires.
 *   - jump-to-latest-unread          : the top pill scrolls back to the divider.
 *   - jump-to-replied-message        : clicking a reply quote jumps to the parent.
 *
 * Setup: `owner` posts, `reader` reads. `reader` never opens the channel before
 * the assertions, so their server-side read-state is null (never read) → every
 * one of owner's messages is unread → the divider anchors at the top.
 */
import { expect, test } from '@playwright/test'
import { authenticatePage, selectChannel, selectServer } from './fixtures/auth-fixture'
import {
  createInvite,
  createServer,
  getServerChannels,
  joinServer,
  sendMessage,
  sendReply,
  syncProfile,
} from './fixtures/test-data-factory'
import { createTestUser, type TestUser } from './fixtures/user-factory'

test.describe('Unread divider + jump-to-message', () => {
  let owner: TestUser
  let reader: TestUser

  async function freshChannel(prefix: string): Promise<{ serverId: string; channelId: string }> {
    const server = await createServer(owner.token, `${prefix}-${Date.now()}`)
    const channels = await getServerChannels(owner.token, server.id)
    const general = channels.items.find((c) => c.name === 'general')
    if (general === undefined) throw new Error('Expected #general after server creation')
    const invite = await createInvite(owner.token, server.id)
    await joinServer(reader.token, server.id, invite.code)
    return { serverId: server.id, channelId: general.id }
  }

  test.beforeAll(async () => {
    owner = await createTestUser('ud-owner')
    reader = await createTestUser('ud-reader')
    await syncProfile(owner.token)
    await syncProfile(reader.token)
  })

  test('unread-divider-appears-on-open: the divider renders above the first unread message', async ({
    page,
  }) => {
    const { serverId, channelId } = await freshChannel('ud-appears')
    await sendMessage(owner.token, channelId, 'first unread message')
    await sendMessage(owner.token, channelId, 'second unread message')

    await authenticatePage(page, reader)
    await selectServer(page, serverId)
    await selectChannel(page, 'general')

    await expect(page.locator('[data-test="new-messages-divider"]')).toBeVisible()
  })

  test('divider-frozen-while-reading: the divider survives mark-read', async ({ page }) => {
    const { serverId, channelId } = await freshChannel('ud-frozen')
    await sendMessage(owner.token, channelId, 'unread while reading')

    await authenticatePage(page, reader)
    await selectServer(page, serverId)

    // Opening the channel fires mark-read (PATCH read-state). The divider is
    // pinned to the boundary frozen from the read-state GET, so it must NOT
    // disappear when mark-read advances the server-side boundary.
    const markRead = page.waitForResponse(
      (r) =>
        r.url().includes(`/v1/channels/${channelId}/read-state`) &&
        r.request().method() === 'PATCH',
    )
    await selectChannel(page, 'general')
    await expect(page.locator('[data-test="new-messages-divider"]')).toBeVisible()
    await markRead

    // Still frozen in place after the read boundary moved forward.
    await expect(page.locator('[data-test="new-messages-divider"]')).toBeVisible()
  })

  test('jump-to-latest-unread: the top pill scrolls back to the divider', async ({ page }) => {
    const { serverId, channelId } = await freshChannel('ud-jump-unread')
    // Enough messages to overflow the viewport (single page, no pagination),
    // so on open the list auto-scrolls to the bottom and the divider sits above.
    for (let i = 0; i < 40; i++) {
      await sendMessage(owner.token, channelId, `backlog message ${i}`)
    }

    await authenticatePage(page, reader)
    await selectServer(page, serverId)
    await selectChannel(page, 'general')

    // Divider is above the viewport → the "↑ New messages" pill is offered.
    const pill = page.locator('[data-test="jump-to-unread"]')
    await expect(pill).toBeVisible()

    await pill.click()

    // Clicking scrolls the divider into view.
    await expect(page.locator('[data-test="new-messages-divider"]')).toBeInViewport()
  })

  test('jump-to-replied-message: clicking a reply quote scrolls to the parent', async ({
    page,
  }) => {
    const { serverId, channelId } = await freshChannel('ud-jump-reply')
    const parent = await sendMessage(owner.token, channelId, 'the original parent message')
    // Push the parent well above the viewport, then reply to it at the bottom.
    for (let i = 0; i < 30; i++) {
      await sendMessage(owner.token, channelId, `filler ${i}`)
    }
    await sendReply(owner.token, channelId, 'a reply pointing back up', parent.id)

    await authenticatePage(page, reader)
    await selectServer(page, serverId)
    await selectChannel(page, 'general')

    // The reply quote is a button labelled from messages:jumpToRepliedMessage.
    const quote = page.getByRole('button', { name: 'Jump to replied message' })
    await expect(quote).toBeVisible()
    await quote.click()

    // The parent message scrolls into view.
    await expect(
      page
        .locator('[data-test="message-content"]')
        .filter({ hasText: 'the original parent message' }),
    ).toBeInViewport()
  })
})
