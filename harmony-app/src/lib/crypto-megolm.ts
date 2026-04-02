/**
 * Tauri Megolm crypto command wrappers — thin layer over vodozemac Megolm (Phase F).
 *
 * WHY: Centralizes all Tauri invoke() calls for Megolm (group encryption) operations.
 * Follows the same pattern as crypto.ts (Olm wrappers).
 * All functions are behind isTauri() guards — they throw if invoked on web.
 *
 * WHY dynamic import: `@tauri-apps/api/core` crashes if loaded in the browser.
 * Lazy importing ensures the module is only resolved inside the Tauri shell.
 */

import { isTauri } from '@/lib/platform'

/** WHY: Avoids top-level import of @tauri-apps/api which crashes on web. */
async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw new Error('Megolm crypto requires desktop app')
  }
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core')
  return tauriInvoke<T>(cmd, args)
}

// --- Return types matching Phase F Rust commands ---

interface MegolmOutboundSession {
  session_id: string
  session_key: string
}

interface MegolmEncryptedPayload {
  session_id: string
  ciphertext: string
}

// --- Megolm operations ---

/** Create an outbound Megolm session for a channel. Returns session ID + session key for sharing. */
export function createOutboundSession(channelId: string): Promise<MegolmOutboundSession> {
  return invoke<MegolmOutboundSession>('megolm_create_outbound_session', { channelId })
}

/** Encrypt plaintext using the outbound Megolm session for a channel. */
export function megolmEncrypt(
  channelId: string,
  plaintext: string,
): Promise<MegolmEncryptedPayload> {
  return invoke<MegolmEncryptedPayload>('megolm_encrypt', { channelId, plaintext })
}

/** Decrypt ciphertext using an inbound Megolm session. */
export function megolmDecrypt(
  channelId: string,
  sessionId: string,
  ciphertext: string,
): Promise<string> {
  return invoke<string>('megolm_decrypt', { channelId, sessionId, ciphertext })
}
