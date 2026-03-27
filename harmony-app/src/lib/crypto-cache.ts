/**
 * Tauri SQLCipher cache wrappers — local encrypted message storage (Phase A).
 *
 * WHY: Decrypted DM messages are cached locally so they don't need to be
 * re-decrypted on every view. The SQLCipher database is encrypted at rest
 * and only accessible from the Tauri desktop shell.
 *
 * All functions throw if called on web — callers must check isTauri() first.
 */

import { isTauri } from '@/lib/platform'

/** WHY: Avoids top-level import of @tauri-apps/api which crashes on web. */
async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw new Error('Message cache requires desktop app')
  }
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core')
  return tauriInvoke<T>(cmd, args)
}

interface CachedMessage {
  message_id: string
  channel_id: string
  plaintext: string
  created_at: string
}

/** Initialize the SQLCipher cache database for a user. */
export function initCache(userId: string): Promise<void> {
  return invoke<void>('cache_init', { userId })
}

/** Store a decrypted message in the local cache. */
export function cacheMessage(
  messageId: string,
  channelId: string,
  plaintext: string,
  createdAt: string,
): Promise<void> {
  return invoke<void>('cache_message', {
    messageId,
    channelId,
    plaintext,
    createdAt,
  })
}

/** Retrieve cached decrypted messages for a channel (cursor-paginated). */
export function getCachedMessages(
  channelId: string,
  beforeCursor?: string,
  limit?: number,
): Promise<CachedMessage[]> {
  return invoke<CachedMessage[]>('get_cached_messages', {
    channelId,
    beforeCursor,
    limit,
  })
}

/** Update a cached message's plaintext (e.g., after edit). */
export function updateCachedMessage(messageId: string, newPlaintext: string): Promise<void> {
  return invoke<void>('update_cached_message', { messageId, newPlaintext })
}

/** Delete a cached message. */
export function deleteCachedMessage(messageId: string): Promise<void> {
  return invoke<void>('delete_cached_message', { messageId })
}

export type TrustLevel = 'unverified' | 'verified' | 'blocked'

/** Set the local trust level for a user. Stored locally only — the server never knows. */
export function setTrustLevel(userId: string, level: TrustLevel): Promise<void> {
  return invoke<void>('crypto_set_trust_level', { userId, level })
}

/** Get the local trust level for a user. Returns "unverified" if no record exists. */
export function getTrustLevel(userId: string): Promise<TrustLevel> {
  return invoke<TrustLevel>('crypto_get_trust_level', { userId })
}
