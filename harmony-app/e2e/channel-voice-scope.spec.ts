/**
 * E2E Tests — F5: private channel invisible over realtime to non-member
 *
 * Ticket §7.4 (dev/active/tickets/f5-channel-voice-sse-leak.md): the SSE
 * Stage-2 filter gates ChannelCreated/Updated/Deleted and VoiceStateUpdate on
 * channel access. A server member with NO grant to a private channel must not
 * learn of it — its existence, name, topic, or voice roster — over the live
 * `/v1/events` stream, matching what REST already hides.
 *
 * Proof strategy for "never receives" (absence over SSE is unobservable
 * directly): after each private-channel mutation the owner creates a PUBLIC
 * sentinel channel. SSE is FIFO per connection, so once the sentinel appears
 * in the member's sidebar, every earlier event (including the private one, had
 * it leaked) has been processed — asserting absence is then deterministic,
 * not a race. A final reload confirms REST parity.
 *
 * SSE realtime events used:
 * - channel.created / channel.updated: useRealtimeChannels patches the sidebar cache
 * - voice.state_update: useRealtimeVoice patches the voice participant cache
 *
 * Real data-test attributes from:
 * - channel-sidebar.tsx (channel-list, channel-button)
 * - voice-participant-list.tsx:47 (voice-participant-list), :89 (voice-participant-{userId})
 */
import { expect, test } from '@playwright/test'
import { authenticatePage, selectServer } from './fixtures/auth-fixture'
import {
  createChannel,
  createInvite,
  createServer,
  joinServer,
  syncProfile,
  updateChannel,
} from './fixtures/test-data-factory'
import { createTestUser, type TestUser } from './fixtures/user-factory'

// WHY: Mirrors test-data-factory.ts — configurable for CI, local dev default.
const API_URL = process.env.VITE_API_URL ?? 'http://localhost:3000'

/** POST /v1/servers/{id}/channels with an explicit channelType (factory lacks it). */
async function createVoiceChannel(
  token: string,
  serverId: string,
  name: string,
  isPrivate: boolean,
): Promise<{ id: string; name: string }> {
  const res = await fetch(`${API_URL}/v1/servers/${serverId}/channels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name, channelType: 'voice', isPrivate }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`createVoiceChannel failed: ${res.status} ${body}`)
  }
  return (await res.json()) as { id: string; name: string }
}

/** POST /v1/channels/{id}/voice/join — non-throwing so 503 (voice disabled) can be skipped. */
async function joinVoiceRaw(token: string, channelId: string): Promise<number> {
  const res = await fetch(`${API_URL}/v1/channels/${channelId}/voice/join`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
  return res.status
}

test.describe('F5 — private channel/voice SSE scope', () => {
  let owner: TestUser
  let member: TestUser
  let server: { id: string; name: string }

  test.beforeAll(async () => {
    owner = await createTestUser('f5-scope-owner')
    member = await createTestUser('f5-scope-member')
    for (const u of [owner, member]) await syncProfile(u.token)

    server = await createServer(owner.token, `F5 Scope E2E ${Date.now()}`)
    const invite = await createInvite(owner.token, server.id)
    await joinServer(member.token, server.id, invite.code)
  })

  test('private channel invisible over realtime to non-member', async ({ page }) => {
    // Non-authorized member watches the sidebar over a live SSE connection.
    await authenticatePage(page, member)
    await selectServer(page, server.id)
    const channelList = page.locator('[data-test="channel-list"]')
    await channelList.waitFor({ timeout: 15_000 })

    // Owner creates a PRIVATE channel (no grant for the member).
    const privateName = `f5-priv-${Date.now()}`
    const privateChannel = await createChannel(owner.token, server.id, privateName, {
      isPrivate: true,
    })

    // Sentinel 1: a PUBLIC channel created AFTER the private one. Once it
    // arrives live, the private channel.created (had it leaked) is already
    // processed — absence is now a deterministic assertion, and the sentinel
    // doubles as the fail-open control (public events must keep flowing).
    const sentinel1 = `f5-sentinel1-${Date.now()}`
    await createChannel(owner.token, server.id, sentinel1)
    await expect(
      page.locator('[data-test="channel-button"]').filter({ hasText: sentinel1 }),
    ).toBeVisible({ timeout: 15_000 })
    await expect(
      page.locator('[data-test="channel-button"]').filter({ hasText: privateName }),
    ).toHaveCount(0)

    // Owner renames the private channel → channel.updated must also be gated.
    const renamedName = `f5-priv-renamed-${Date.now()}`
    await updateChannel(owner.token, server.id, privateChannel.id, { name: renamedName })

    // Sentinel 2 flushes the rename event past the member's SSE cursor.
    const sentinel2 = `f5-sentinel2-${Date.now()}`
    await createChannel(owner.token, server.id, sentinel2)
    await expect(
      page.locator('[data-test="channel-button"]').filter({ hasText: sentinel2 }),
    ).toBeVisible({ timeout: 15_000 })
    for (const leaked of [privateName, renamedName]) {
      await expect(
        page.locator('[data-test="channel-button"]').filter({ hasText: leaked }),
      ).toHaveCount(0)
    }

    // Reload → REST parity: the list_for_server filter hides the private
    // channel identically, so nothing "reappears" from a refetch.
    await page.reload()
    await selectServer(page, server.id)
    await channelList.waitFor({ timeout: 15_000 })
    await expect(
      page.locator('[data-test="channel-button"]').filter({ hasText: sentinel1 }),
    ).toBeVisible({ timeout: 15_000 })
    for (const leaked of [privateName, renamedName]) {
      await expect(
        page.locator('[data-test="channel-button"]').filter({ hasText: leaked }),
      ).toHaveCount(0)
    }
  })

  test('private voice roster invisible over realtime to non-member', async ({ page }) => {
    // Owner will join a PRIVATE voice channel; the member's client must never
    // render the owner as a voice participant (voice.state_update is gated).
    const privateVoice = await createVoiceChannel(
      owner.token,
      server.id,
      `f5-voice-priv-${Date.now()}`,
      true,
    )

    await authenticatePage(page, member)
    await selectServer(page, server.id)
    await page.locator('[data-test="channel-list"]').waitFor({ timeout: 15_000 })

    const joinStatus = await joinVoiceRaw(owner.token, privateVoice.id)
    // WHY: voice is optional infrastructure (LiveKit env vars); 503 = disabled
    // in this environment — the roster assertion below would be vacuous.
    test.skip(joinStatus === 503, 'voice disabled in this environment (no LiveKit)')
    expect(joinStatus).toBe(200)

    // Sentinel: flushes the voice.state_update past the member's SSE cursor.
    const sentinel = `f5-voice-sentinel-${Date.now()}`
    await createChannel(owner.token, server.id, sentinel)
    await expect(
      page.locator('[data-test="channel-button"]').filter({ hasText: sentinel }),
    ).toBeVisible({ timeout: 15_000 })

    // The member must see neither the private voice channel nor its roster.
    await expect(
      page.locator('[data-test="channel-button"]').filter({ hasText: privateVoice.name }),
    ).toHaveCount(0)
    await expect(page.locator(`[data-test="voice-participant-${owner.id}"]`)).toHaveCount(0)

    // Reload → still absent (REST parity for the participants fetch too).
    await page.reload()
    await selectServer(page, server.id)
    await page.locator('[data-test="channel-list"]').waitFor({ timeout: 15_000 })
    await expect(
      page.locator('[data-test="channel-button"]').filter({ hasText: privateVoice.name }),
    ).toHaveCount(0)
    await expect(page.locator(`[data-test="voice-participant-${owner.id}"]`)).toHaveCount(0)
  })
})
