/**
 * Factory functions to create test data via the Harmony REST API.
 *
 * WHY: E2E tests need servers, channels, invites etc. created before UI
 * assertions. These functions call the real API to avoid test coupling
 * to internal DB structure.
 */

// WHY: Configurable for CI (deployed API) while defaulting to local dev.
const API_URL = process.env.VITE_API_URL ?? 'http://localhost:3000'

function authHeaders(token: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  }
}

/** POST /v1/auth/me — must be called after createTestUser to upsert profile. */
export async function syncProfile(token: string): Promise<void> {
  const res = await fetch(`${API_URL}/v1/auth/me`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`syncProfile failed: ${res.status} ${body}`)
  }
}

/** POST /v1/servers — creates a server and returns { id, name }. */
export async function createServer(
  token: string,
  name?: string,
): Promise<{ id: string; name: string }> {
  const serverName = name ?? `test-server-${Date.now()}`
  const res = await fetch(`${API_URL}/v1/servers`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ name: serverName }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`createServer failed: ${res.status} ${body}`)
  }
  return (await res.json()) as { id: string; name: string }
}

/** GET /v1/servers/{id}/channels — returns channels for a server. */
export async function getServerChannels(
  token: string,
  serverId: string,
): Promise<{ items: Array<{ id: string; name: string; encrypted: boolean }> }> {
  const res = await fetch(`${API_URL}/v1/servers/${serverId}/channels`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`getServerChannels failed: ${res.status} ${body}`)
  }
  return (await res.json()) as { items: Array<{ id: string; name: string; encrypted: boolean }> }
}

/** POST /v1/servers/{id}/channels — creates a channel. Accepts optional isPrivate/isReadOnly. */
export async function createChannel(
  token: string,
  serverId: string,
  name: string,
  opts?: { isPrivate?: boolean; isReadOnly?: boolean },
): Promise<{ id: string; name: string }> {
  const res = await fetch(`${API_URL}/v1/servers/${serverId}/channels`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      name,
      channelType: 'text',
      isPrivate: opts?.isPrivate ?? false,
      isReadOnly: opts?.isReadOnly ?? false,
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`createChannel failed: ${res.status} ${body}`)
  }
  return (await res.json()) as { id: string; name: string }
}

/** POST /v1/servers/{id}/invites — creates an invite and returns the code. */
export async function createInvite(token: string, serverId: string): Promise<{ code: string }> {
  const res = await fetch(`${API_URL}/v1/servers/${serverId}/invites`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ maxUses: null, expiresInHours: null }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`createInvite failed: ${res.status} ${body}`)
  }
  return (await res.json()) as { code: string }
}

/** POST /v1/servers/{id}/members — joins a server with an invite code. */
export async function joinServer(
  token: string,
  serverId: string,
  inviteCode: string,
): Promise<void> {
  const res = await fetch(`${API_URL}/v1/servers/${serverId}/members`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ inviteCode }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`joinServer failed: ${res.status} ${body}`)
  }
}

/** GET /v1/invites/{code} — preview an invite (public, no auth). */
export async function previewInvite(
  code: string,
): Promise<{ serverId: string; serverName: string; memberCount: number }> {
  const res = await fetch(`${API_URL}/v1/invites/${code}`, {
    method: 'GET',
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`previewInvite failed: ${res.status} ${body}`)
  }
  return (await res.json()) as { serverId: string; serverName: string; memberCount: number }
}

/** POST /v1/channels/{id}/messages — send a message to a channel. */
export async function sendMessage(
  token: string,
  channelId: string,
  content: string,
): Promise<{ id: string; content: string; createdAt: string }> {
  const res = await fetch(`${API_URL}/v1/channels/${channelId}/messages`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ content }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`sendMessage failed: ${res.status} ${body}`)
  }
  return (await res.json()) as { id: string; content: string; createdAt: string }
}

/**
 * POST /v1/channels/{id}/messages — non-throwing variant that returns the raw Response.
 * WHY: Used by tests that assert on specific HTTP status codes (e.g., 429 rate limit).
 */
export async function sendMessageRaw(
  token: string,
  channelId: string,
  content: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${API_URL}/v1/channels/${channelId}/messages`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ content }),
  })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

/** DELETE /v1/channels/{id}/messages/{messageId} — soft-delete a message. */
export async function deleteMessage(
  token: string,
  channelId: string,
  messageId: string,
): Promise<void> {
  const res = await fetch(`${API_URL}/v1/channels/${channelId}/messages/${messageId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`deleteMessage failed: ${res.status} ${body}`)
  }
}

/** PATCH /v1/channels/{id}/messages/{messageId} — edit a message's content. */
export async function editMessage(
  token: string,
  channelId: string,
  messageId: string,
  content: string,
): Promise<{ id: string; content: string; editedAt: string }> {
  const res = await fetch(`${API_URL}/v1/channels/${channelId}/messages/${messageId}`, {
    method: 'PATCH',
    headers: authHeaders(token),
    body: JSON.stringify({ content }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`editMessage failed: ${res.status} ${body}`)
  }
  return (await res.json()) as { id: string; content: string; editedAt: string }
}

/** DELETE /v1/servers/{id}/members/{user_id} — kick a member from a server. */
export async function kickMember(token: string, serverId: string, userId: string): Promise<void> {
  const res = await fetch(`${API_URL}/v1/servers/${serverId}/members/${userId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`kickMember failed: ${res.status} ${body}`)
  }
}

/** DELETE /v1/servers/{id}/channels/{channelId} — delete a channel. */
export async function deleteChannel(
  token: string,
  serverId: string,
  channelId: string,
): Promise<void> {
  const res = await fetch(`${API_URL}/v1/servers/${serverId}/channels/${channelId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`deleteChannel failed: ${res.status} ${body}`)
  }
}

/** PATCH /v1/servers/{id}/channels/{channelId} — update a channel. */
export async function updateChannel(
  token: string,
  serverId: string,
  channelId: string,
  data: { encrypted?: boolean; isPrivate?: boolean; isReadOnly?: boolean; name?: string },
): Promise<{ id: string; name: string; encrypted: boolean }> {
  const res = await fetch(`${API_URL}/v1/servers/${serverId}/channels/${channelId}`, {
    method: 'PATCH',
    headers: authHeaders(token),
    body: JSON.stringify(data),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`updateChannel failed: ${res.status} ${body}`)
  }
  return (await res.json()) as { id: string; name: string; encrypted: boolean }
}

/**
 * PATCH /v1/servers/{id}/channels/{channelId} — non-throwing variant.
 * WHY: Used by tests that assert on specific HTTP status codes (e.g., 403, 409).
 */
export async function updateChannelRaw(
  token: string,
  serverId: string,
  channelId: string,
  data: { encrypted?: boolean; isPrivate?: boolean; isReadOnly?: boolean; name?: string },
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${API_URL}/v1/servers/${serverId}/channels/${channelId}`, {
    method: 'PATCH',
    headers: authHeaders(token),
    body: JSON.stringify(data),
  })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

/** PATCH /v1/servers/{id} — update a server's name. */
export async function updateServer(
  token: string,
  serverId: string,
  data: { name?: string },
): Promise<{ id: string; name: string }> {
  const res = await fetch(`${API_URL}/v1/servers/${serverId}`, {
    method: 'PATCH',
    headers: authHeaders(token),
    body: JSON.stringify(data),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`updateServer failed: ${res.status} ${body}`)
  }
  return (await res.json()) as { id: string; name: string }
}

/** PATCH /v1/servers/{id}/members/{user_id}/role — assign a role to a member. */
export async function assignRole(
  token: string,
  serverId: string,
  userId: string,
  role: string,
): Promise<void> {
  const res = await fetch(`${API_URL}/v1/servers/${serverId}/members/${userId}/role`, {
    method: 'PATCH',
    headers: authHeaders(token),
    body: JSON.stringify({ role }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`assignRole failed: ${res.status} ${body}`)
  }
}

/** POST /v1/servers/{id}/transfer-ownership — transfer server ownership. */
export async function transferOwnership(
  token: string,
  serverId: string,
  newOwnerId: string,
): Promise<void> {
  const res = await fetch(`${API_URL}/v1/servers/${serverId}/transfer-ownership`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ newOwnerId }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`transferOwnership failed: ${res.status} ${body}`)
  }
}

/** POST /v1/servers/{id}/bans — ban a user from a server. */
export async function banUser(
  token: string,
  serverId: string,
  userId: string,
  reason?: string,
): Promise<void> {
  const res = await fetch(`${API_URL}/v1/servers/${serverId}/bans`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ userId, reason: reason ?? null }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`banUser failed: ${res.status} ${body}`)
  }
}

/** DELETE /v1/servers/{id}/bans/{user_id} — unban a user from a server. */
export async function unbanUser(token: string, serverId: string, userId: string): Promise<void> {
  const res = await fetch(`${API_URL}/v1/servers/${serverId}/bans/${userId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`unbanUser failed: ${res.status} ${body}`)
  }
}

/**
 * POST /v1/servers/{id}/channels — non-throwing variant that returns the raw Response.
 * WHY: Used by tests that assert on specific HTTP status codes (e.g., 403 LimitExceeded).
 */
export async function createChannelRaw(
  token: string,
  serverId: string,
  name: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${API_URL}/v1/servers/${serverId}/channels`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      name,
      channelType: 'text',
      isPrivate: false,
      isReadOnly: false,
    }),
  })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

/**
 * POST /v1/servers — non-throwing variant that returns the raw Response.
 * WHY: Used by tests that assert on specific HTTP status codes (e.g., 403 LimitExceeded).
 */
export async function createServerRaw(
  token: string,
  name?: string,
): Promise<{ status: number; body: unknown }> {
  const serverName = name ?? `test-server-${Date.now()}`
  const res = await fetch(`${API_URL}/v1/servers`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ name: serverName }),
  })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

/** POST /v1/dms — create or get a DM conversation. */
export async function createDm(
  token: string,
  recipientId: string,
): Promise<{ serverId: string; channelId: string }> {
  const res = await fetch(`${API_URL}/v1/dms`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ recipientId }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`createDm failed: ${res.status} ${body}`)
  }
  return (await res.json()) as { serverId: string; channelId: string }
}

/**
 * POST /v1/dms — non-throwing variant that returns the raw Response.
 * WHY: Used by tests that assert on specific HTTP status codes (e.g., 400, 429).
 */
export async function createDmRaw(
  token: string,
  recipientId: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${API_URL}/v1/dms`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ recipientId }),
  })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

/**
 * POST /v1/servers/{id}/members — non-throwing variant that returns the raw Response.
 * WHY: Used by tests that assert on specific HTTP status codes (e.g., 403 banned user).
 */
export async function joinServerRaw(
  token: string,
  serverId: string,
  inviteCode: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${API_URL}/v1/servers/${serverId}/members`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ inviteCode }),
  })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

/** DELETE /v1/dms/{server_id} — close (leave) a DM conversation. */
export async function closeDm(token: string, serverId: string): Promise<void> {
  const res = await fetch(`${API_URL}/v1/dms/${serverId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`closeDm failed: ${res.status} ${body}`)
  }
}
