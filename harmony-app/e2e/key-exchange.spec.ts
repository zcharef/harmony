/**
 * E2E Tests — Key Exchange API
 *
 * Verifies the E2EE key distribution endpoints that enable Olm session establishment:
 * - Device registration (identity + signing keys)
 * - One-time key upload and count tracking
 * - Pre-key bundle claiming (consumes one-time keys atomically)
 * - Fallback key behavior when one-time keys are exhausted
 * - Device listing and removal with key cleanup
 *
 * WHY pure API tests: These endpoints are consumed by the Tauri desktop client's
 * Rust crypto layer (vodozemac). The web client never calls them directly, so
 * there is no UI to test — only the HTTP contract matters.
 *
 * Source: harmony-api/src/api/handlers/keys.rs
 * DTOs: harmony-api/src/api/dto/keys.rs
 */
import crypto from 'node:crypto'
import { expect, test } from '@playwright/test'
import {
  assignRole,
  createChannel,
  createDm,
  createInvite,
  createServer,
  getMessages,
  getServerChannels,
  joinServer,
  sendEncryptedMessage,
  sendMessage,
  syncProfile,
  updateChannel,
  updateChannelRaw,
} from './fixtures/test-data-factory'
import { createTestUser, type TestUser } from './fixtures/user-factory'

// WHY: Configurable for CI (deployed API) while defaulting to local dev.
const API_URL = process.env.VITE_API_URL ?? 'http://localhost:3000'

function authHeaders(token: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  }
}

/** Generate a realistic-looking base64 key for test payloads. */
function fakeKey(): string {
  return Buffer.from(crypto.randomUUID()).toString('base64')
}

/** Generate a unique device ID scoped to avoid collisions across parallel runs. */
function fakeDeviceId(): string {
  return `device-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
}

/** Build a one-time key DTO. */
function oneTimeKey(opts?: { isFallback?: boolean }): {
  keyId: string
  publicKey: string
  isFallback: boolean
} {
  return {
    keyId: crypto.randomUUID(),
    publicKey: fakeKey(),
    isFallback: opts?.isFallback ?? false,
  }
}

// ─── Helpers for raw API calls ────────────────────────────────────────────────
// WHY: These endpoints are not in test-data-factory because they are the SUT
// (System Under Test) for this spec. Helpers here keep tests readable without
// polluting the shared factory.

async function registerDevice(
  token: string,
  deviceId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${API_URL}/v1/keys/device`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      deviceId,
      identityKey: fakeKey(),
      signingKey: fakeKey(),
      deviceName: `E2E Test Device ${deviceId.slice(-8)}`,
    }),
  })
  const body = ((await res.json().catch(() => null)) ?? {}) as Record<string, unknown>
  return { status: res.status, body }
}

async function uploadKeys(
  token: string,
  deviceId: string,
  keys: Array<{ keyId: string; publicKey: string; isFallback: boolean }>,
): Promise<{ status: number }> {
  const res = await fetch(`${API_URL}/v1/keys/one-time`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ deviceId, keys }),
  })
  return { status: res.status }
}

async function getKeyCount(
  token: string,
  deviceId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${API_URL}/v1/keys/count?deviceId=${encodeURIComponent(deviceId)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  })
  const body = ((await res.json().catch(() => null)) ?? {}) as Record<string, unknown>
  return { status: res.status, body }
}

async function claimBundle(
  token: string,
  targetUserId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${API_URL}/v1/keys/bundle/${targetUserId}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  })
  const body = ((await res.json().catch(() => null)) ?? {}) as Record<string, unknown>
  return { status: res.status, body }
}

async function listDevices(
  token: string,
  userId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${API_URL}/v1/keys/devices/${userId}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  })
  const body = ((await res.json().catch(() => null)) ?? {}) as Record<string, unknown>
  return { status: res.status, body }
}

async function removeDevice(token: string, deviceId: string): Promise<{ status: number }> {
  const res = await fetch(`${API_URL}/v1/keys/device/${encodeURIComponent(deviceId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  return { status: res.status }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Test Suite
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('Key Exchange API', () => {
  let alice: TestUser
  let bob: TestUser

  test.beforeAll(async () => {
    alice = await createTestUser('keys-alice')
    bob = await createTestUser('keys-bob')
    // WHY: syncProfile upserts the user row in the profiles table so the API
    // can resolve user_id references in key distribution endpoints.
    for (const u of [alice, bob]) await syncProfile(u.token)
  })

  // ── Device Registration ───────────────────────────────────────────────────

  test('register device and verify response', async () => {
    const deviceId = fakeDeviceId()
    const { status, body } = await registerDevice(alice.token, deviceId)

    expect(status).toBe(201)
    expect(body.deviceId).toBe(deviceId)
    expect(body.userId).toBe(alice.id)
    expect(body.identityKey).toBeDefined()
    expect(body.signingKey).toBeDefined()
    expect(body.createdAt).toBeDefined()
  })

  // ── One-Time Key Upload & Count ───────────────────────────────────────────

  test('upload one-time keys and verify count', async () => {
    const deviceId = fakeDeviceId()
    const regRes = await registerDevice(alice.token, deviceId)
    expect(regRes.status).toBe(201)

    const keys = Array.from({ length: 10 }, () => oneTimeKey())
    const uploadRes = await uploadKeys(alice.token, deviceId, keys)
    expect(uploadRes.status).toBe(204)

    const countRes = await getKeyCount(alice.token, deviceId)
    expect(countRes.status).toBe(200)
    expect(countRes.body.count).toBe(10)
  })

  // ── Pre-Key Bundle Claiming ───────────────────────────────────────────────

  test('claim pre-key bundle consumes one-time key', async () => {
    // WHY: Fresh user so get_pre_key_bundle picks THIS device (the only one),
    // not an older keyless device registered by a previous test.
    const claimUser = await createTestUser('keys-claim')
    await syncProfile(claimUser.token)

    const deviceId = fakeDeviceId()
    const regRes = await registerDevice(claimUser.token, deviceId)
    expect(regRes.status).toBe(201)

    const keys = Array.from({ length: 3 }, () => oneTimeKey())
    const uploadRes = await uploadKeys(claimUser.token, deviceId, keys)
    expect(uploadRes.status).toBe(204)

    // Bob claims claimUser's bundle — should consume exactly one one-time key.
    const bundleRes = await claimBundle(bob.token, claimUser.id)
    expect(bundleRes.status).toBe(200)
    expect(bundleRes.body.userId).toBe(claimUser.id)
    expect(bundleRes.body.identityKey).toBeDefined()
    expect(bundleRes.body.signingKey).toBeDefined()
    expect(bundleRes.body.oneTimeKey).toBeDefined()

    // Verify count decreased from 3 to 2.
    const countRes = await getKeyCount(claimUser.token, deviceId)
    expect(countRes.status).toBe(200)
    expect(countRes.body.count).toBe(2)
  })

  // ── Fallback Key Behavior ─────────────────────────────────────────────────

  test('key exhaustion falls back to fallback key', async () => {
    // WHY: Fresh user so get_pre_key_bundle picks THIS device (the only one),
    // not an older keyless device registered by a previous test.
    const exhaustUser = await createTestUser('keys-exhaust')
    await syncProfile(exhaustUser.token)

    const deviceId = fakeDeviceId()
    const regRes = await registerDevice(exhaustUser.token, deviceId)
    expect(regRes.status).toBe(201)

    // Upload 1 one-time key + 1 fallback key.
    const otk = oneTimeKey({ isFallback: false })
    const fbk = oneTimeKey({ isFallback: true })
    const uploadRes = await uploadKeys(exhaustUser.token, deviceId, [otk, fbk])
    expect(uploadRes.status).toBe(204)

    // First claim: consumes the one-time key.
    const bundle1 = await claimBundle(bob.token, exhaustUser.id)
    expect(bundle1.status).toBe(200)
    expect(bundle1.body.oneTimeKey).toBeDefined()

    // Verify one-time key count is now 0.
    const countRes = await getKeyCount(exhaustUser.token, deviceId)
    expect(countRes.body.count).toBe(0)

    // Second claim: one-time keys exhausted, should return fallback key.
    // WHY: Fallback keys are NOT consumed — they persist until rotated.
    const bundle2 = await claimBundle(bob.token, exhaustUser.id)
    expect(bundle2.status).toBe(200)
    expect(bundle2.body.fallbackKey).toBeDefined()
    // One-time key should be absent since none remain.
    expect(bundle2.body.oneTimeKey).toBeUndefined()
  })

  // ── Device Listing ────────────────────────────────────────────────────────

  test('list devices returns registered devices', async () => {
    // WHY: Create a fresh user so we control the exact device count.
    const user = await createTestUser('keys-devices')
    await syncProfile(user.token)

    const deviceId1 = fakeDeviceId()
    const deviceId2 = fakeDeviceId()
    await registerDevice(user.token, deviceId1)
    await registerDevice(user.token, deviceId2)

    const { status, body } = await listDevices(user.token, user.id)
    expect(status).toBe(200)

    const items = body.items as Array<Record<string, unknown>>
    expect(items.length).toBe(2)

    const deviceIds = items.map((d) => d.deviceId)
    expect(deviceIds).toContain(deviceId1)
    expect(deviceIds).toContain(deviceId2)
  })

  // ── Device Removal ────────────────────────────────────────────────────────

  test('remove device cleans up', async () => {
    // WHY: Create a fresh user so removal assertions are not affected by other tests.
    const user = await createTestUser('keys-remove')
    await syncProfile(user.token)

    const deviceId = fakeDeviceId()
    await registerDevice(user.token, deviceId)
    await uploadKeys(
      user.token,
      deviceId,
      Array.from({ length: 5 }, () => oneTimeKey()),
    )

    // Verify device exists before removal.
    const beforeRes = await listDevices(user.token, user.id)
    const beforeItems = (beforeRes.body.items as Array<Record<string, unknown>>) ?? []
    expect(beforeItems.some((d) => d.deviceId === deviceId)).toBe(true)

    // Remove the device.
    const removeRes = await removeDevice(user.token, deviceId)
    expect(removeRes.status).toBe(204)

    // Verify device is gone after removal.
    const afterRes = await listDevices(user.token, user.id)
    const afterItems = (afterRes.body.items as Array<Record<string, unknown>>) ?? []
    expect(afterItems.some((d) => d.deviceId === deviceId)).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Channel Encryption API — pure HTTP assertions (no browser/page fixture)
// ═══════════════════════════════════════════════════════════════════════════════
//
// WHY separate describe: These tests verify encryption enforcement at the API level
// (one-way toggle, owner-only, persistence, message flags). They were extracted from
// encryption.spec.ts because they use no Playwright page fixture — pure HTTP only.

test.describe('Channel Encryption API', () => {
  let owner: TestUser
  let admin: TestUser
  let server: { id: string; name: string }
  let encryptedChannel: { id: string; name: string }
  let plainChannel: { id: string; name: string }

  // DM-related state for the encrypted-messages test
  let dmSender: TestUser
  let dmReceiver: TestUser
  let dmData: { serverId: string; channelId: string }
  let encryptedMsgContent: string
  let plaintextMsgContent: string

  test.beforeAll(async () => {
    // ── Server + channel setup ──────────────────────────────────────
    owner = await createTestUser('kx-enc-owner')
    admin = await createTestUser('kx-enc-admin')
    for (const u of [owner, admin]) await syncProfile(u.token)

    server = await createServer(owner.token, `KX Encryption API ${Date.now()}`)

    encryptedChannel = await createChannel(owner.token, server.id, 'kx-secret-channel')
    plainChannel = await createChannel(owner.token, server.id, 'kx-plain-channel')

    // Enable encryption on one channel (owner-only operation).
    await updateChannel(owner.token, server.id, encryptedChannel.id, { encrypted: true })

    const invite = await createInvite(owner.token, server.id)
    await joinServer(admin.token, server.id, invite.code)
    await assignRole(owner.token, server.id, admin.id, 'admin')

    // ── DM setup for encrypted-messages test ────────────────────────
    dmSender = await createTestUser('kx-dm-sender')
    dmReceiver = await createTestUser('kx-dm-receiver')
    for (const u of [dmSender, dmReceiver]) await syncProfile(u.token)

    // WHY: Both users must share a server so they can DM each other.
    const dmServer = await createServer(dmSender.token, `KX DM API ${Date.now()}`)
    const dmInvite = await createInvite(dmSender.token, dmServer.id)
    await joinServer(dmReceiver.token, dmServer.id, dmInvite.code)

    dmData = await createDm(dmSender.token, dmReceiver.id)

    // WHY: DM channels are created as plaintext by default. Encrypted messages
    // are rejected on non-encrypted channels (message_service.rs:126). Enable
    // encryption before sending encrypted messages.
    await updateChannel(dmSender.token, dmData.serverId, dmData.channelId, { encrypted: true })

    // Encrypted message — simulates desktop sender
    encryptedMsgContent = `kx-encrypted-${Date.now()}`
    await sendEncryptedMessage(dmSender.token, dmData.channelId, encryptedMsgContent, 'kx-device-1')

    // Plaintext message — simulates web sender
    plaintextMsgContent = `kx-plaintext-${Date.now()}`
    await sendMessage(dmSender.token, dmData.channelId, plaintextMsgContent)
  })

  test('API rejects disabling encryption on an already-encrypted channel (one-way toggle)', async () => {
    // WHY: UpdateChannelRequest doc says "one-way toggle: once true, cannot be set back to false".
    // This verifies the API enforces that constraint.
    const result = await updateChannelRaw(owner.token, server.id, encryptedChannel.id, {
      encrypted: false,
    })

    // The API should reject the attempt to disable encryption (4xx).
    expect(result.status).toBeGreaterThanOrEqual(400)
  })

  test('API rejects non-owner enabling encryption', async () => {
    // WHY: Only the server owner should be able to enable encryption.
    const result = await updateChannelRaw(admin.token, server.id, plainChannel.id, {
      encrypted: true,
    })

    expect(result.status).toBeGreaterThanOrEqual(400)
  })

  test('API returns encrypted=true for the encrypted channel', async () => {
    // WHY: Verifies data persistence, not just UI visibility.
    const channels = await getServerChannels(owner.token, server.id)

    const enc = channels.items.find((c) => c.id === encryptedChannel.id)
    expect(enc).toBeDefined()
    expect(enc?.encrypted).toBe(true)

    const plain = channels.items.find((c) => c.id === plainChannel.id)
    expect(plain).toBeDefined()
    expect(plain?.encrypted).toBe(false)
  })

  test('API returns encrypted=true for encrypted messages and false for plaintext', async () => {
    // WHY: Pure API test verifying the bug fix — the API now correctly persists
    // encrypted=true and senderDeviceId when sent. No page interaction needed.
    const messages = await getMessages(dmSender.token, dmData.channelId)

    // Find the encrypted message by content.
    const encMsg = messages.items.find((m) => m.content === encryptedMsgContent)
    expect(encMsg).toBeDefined()
    expect(encMsg?.encrypted).toBe(true)
    expect(encMsg?.senderDeviceId).toBeTruthy()

    // Find the plaintext message by content.
    const plainMsg = messages.items.find((m) => m.content === plaintextMsgContent)
    expect(plainMsg).toBeDefined()
    expect(plainMsg?.encrypted).toBe(false)
  })
})
