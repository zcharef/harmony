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
 * Setup: `owner` (plus a co-poster for the high-volume tests) seeds messages,
 * `reader` reads. `reader` never opens the channel before the assertions, so
 * their server-side read-state is null (never read) → every seeded message is
 * unread regardless of author → the divider anchors at the top.
 */
import { expect, test } from '@playwright/test'
import { authenticatePage, selectChannel, selectServer } from './fixtures/auth-fixture'
import {
  createChannel,
  createInvite,
  createServer,
  joinServer,
  sendMessage,
  sendReply,
  syncProfile,
} from './fixtures/test-data-factory'
import { createTestUser, type TestUser } from './fixtures/user-factory'

test.describe('Unread divider + jump-to-message', () => {
  let owner: TestUser
  let reader: TestUser
  // WHY a second poster: the per-plan message rate limit is 5 msgs / 5s per
  // (channel, author). The two high-volume tests seed 30–40 messages, so a
  // single author would 429 repeatedly and (even with the fixture's retry)
  // spend ~35s waiting out the window — dangerously close to the 45s test
  // timeout under CI's --fail-on-flaky-tests. Alternating two authors halves
  // the per-author send rate, keeping the seed comfortably within budget.
  let poster: TestUser
  let serverId: string

  // WHY a fresh channel (not a fresh server) per test: the divider only renders
  // for a reader with a null read-state on the channel, so each test needs an
  // untouched channel. Read-state is per-channel, so a new channel in the shared
  // server gives that isolation while keeping `owner` at ONE owned server — a
  // new server per test would breach the free-plan cap (max_owned_servers = 3)
  // on the 4th test and freeze the e2e deploy gate. Channels are uncapped (10k).
  async function freshChannel(prefix: string): Promise<{ channelId: string; channelName: string }> {
    const channelName = `${prefix}-${Date.now()}`
    const channel = await createChannel(owner.token, serverId, channelName)
    return { channelId: channel.id, channelName }
  }

  test.beforeAll(async () => {
    owner = await createTestUser('ud-owner')
    reader = await createTestUser('ud-reader')
    poster = await createTestUser('ud-poster')
    await syncProfile(owner.token)
    await syncProfile(reader.token)
    await syncProfile(poster.token)

    const server = await createServer(owner.token, `ud-${Date.now()}`)
    serverId = server.id
    // One reused invite for the whole suite: reader and poster both join with it
    // and see every channel created later. A single unlimited-use invite keeps
    // the seed under the free-plan cap (max_active_invites = 5 per server).
    const invite = await createInvite(owner.token, serverId)
    await joinServer(reader.token, serverId, invite.code)
    await joinServer(poster.token, serverId, invite.code)
  })

  test('unread-divider-appears-on-open: the divider renders above the first unread message', async ({
    page,
  }) => {
    const { channelId, channelName } = await freshChannel('ud-appears')
    await sendMessage(owner.token, channelId, 'first unread message')
    await sendMessage(owner.token, channelId, 'second unread message')

    await authenticatePage(page, reader)
    await selectServer(page, serverId)
    await selectChannel(page, channelName)

    await expect(page.locator('[data-test="new-messages-divider"]')).toBeVisible()
  })

  test('divider-frozen-while-reading: the divider survives mark-read', async ({ page }) => {
    const { channelId, channelName } = await freshChannel('ud-frozen')
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
    await selectChannel(page, channelName)
    await expect(page.locator('[data-test="new-messages-divider"]')).toBeVisible()
    await markRead

    // Still frozen in place after the read boundary moved forward.
    await expect(page.locator('[data-test="new-messages-divider"]')).toBeVisible()
  })

  test('jump-to-latest-unread: the top pill scrolls back to the divider', async ({ page }) => {
    const { channelId, channelName } = await freshChannel('ud-jump-unread')
    // Enough messages to overflow the viewport (single page, no pagination),
    // so on open the list auto-scrolls to the bottom and the divider sits above.
    // Alternate authors to stay within the 5/5s per-(channel,author) rate limit.
    const authors = [owner, poster]
    for (let i = 0; i < 40; i++) {
      await sendMessage(authors[i % authors.length].token, channelId, `backlog message ${i}`)
    }

    await authenticatePage(page, reader)
    await selectServer(page, serverId)
    await selectChannel(page, channelName)

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
    const { channelId, channelName } = await freshChannel('ud-jump-reply')
    const parent = await sendMessage(owner.token, channelId, 'the original parent message')
    // Push the parent well above the viewport, then reply to it at the bottom.
    // Alternate authors to stay within the 5/5s per-(channel,author) rate limit.
    const authors = [owner, poster]
    for (let i = 0; i < 30; i++) {
      await sendMessage(authors[i % authors.length].token, channelId, `filler ${i}`)
    }
    await sendReply(owner.token, channelId, 'a reply pointing back up', parent.id)

    await authenticatePage(page, reader)
    await selectServer(page, serverId)
    await selectChannel(page, channelName)

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
