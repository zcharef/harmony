/**
 * Tauri crypto command wrappers — thin layer over vodozemac Olm (Phase A).
 *
 * WHY: Centralizes all Tauri invoke() calls for E2EE crypto operations.
 * All functions are behind isTauri() guards. On web, callers must check
 * isTauri() before calling — these functions throw if invoked on web.
 *
 * WHY dynamic import: `@tauri-apps/api/core` crashes if loaded in the browser.
 * Lazy importing ensures the module is only resolved inside the Tauri shell.
 */

import { isTauri } from '@/lib/platform'

/** WHY: Avoids top-level import of @tauri-apps/api which crashes on web. */
async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw new Error('Crypto requires desktop app')
  }
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core')
  return tauriInvoke<T>(cmd, args)
}

// --- Return types matching Rust commands (src-tauri/src/crypto/mod.rs) ---

export interface OneTimeKeyInfo {
  key_id: string
  public_key: string
}

export interface FallbackKeyInfo {
  key_id: string
  public_key: string
}

export interface CryptoIdentityKeys {
  identity_key: string
  signing_key: string
  one_time_keys: OneTimeKeyInfo[]
}

export interface CryptoKeyPair {
  identity_key: string
  signing_key: string
}

export interface EncryptedPayload {
  message_type: number
  ciphertext: string
}

export interface InboundSessionResult {
  session_id: string
  plaintext: string
}

export interface BatchDecryptInput {
  session_id: string
  message_type: number
  ciphertext: string
}

export interface BatchDecryptResult {
  session_id: string
  plaintext: string | null
  error: string | null
}

// --- Crypto operations ---

/** Initialize the Olm machine for a user. Returns identity keys + initial one-time keys. */
export function initCrypto(userId: string): Promise<CryptoIdentityKeys> {
  return invoke<CryptoIdentityKeys>('crypto_init', { userId })
}

/** Get the local device's identity keys (Curve25519 + Ed25519). */
export function getIdentityKeys(): Promise<CryptoKeyPair> {
  return invoke<CryptoKeyPair>('crypto_get_identity_keys')
}

/** Generate new one-time pre-keys for upload. */
export function generateOneTimeKeys(count: number): Promise<OneTimeKeyInfo[]> {
  return invoke<OneTimeKeyInfo[]>('crypto_generate_one_time_keys', { count })
}

/** Generate a new fallback key. */
export function generateFallbackKey(): Promise<FallbackKeyInfo> {
  return invoke<FallbackKeyInfo>('crypto_generate_fallback_key')
}

/** Create an outbound Olm session using the recipient's pre-key bundle. */
export function createOutboundSession(
  theirIdentityKey: string,
  theirOneTimeKey: string,
): Promise<string> {
  return invoke<string>('crypto_create_outbound_session', {
    theirIdentityKey,
    theirOneTimeKey,
  })
}

/** Create an inbound Olm session from a pre-key message. Returns session_id + decrypted plaintext. */
export function createInboundSession(
  identityKey: string,
  message: string,
): Promise<InboundSessionResult> {
  return invoke<InboundSessionResult>('crypto_create_inbound_session', {
    identityKey,
    message,
  })
}

/** Encrypt plaintext using an established Olm session. */
export function encrypt(sessionId: string, plaintext: string): Promise<EncryptedPayload> {
  return invoke<EncryptedPayload>('crypto_encrypt', { sessionId, plaintext })
}

/** Decrypt a single message using an established Olm session. */
export function decrypt(
  sessionId: string,
  messageType: number,
  ciphertext: string,
): Promise<string> {
  return invoke<string>('crypto_decrypt', { sessionId, messageType, ciphertext })
}

/** Decrypt a batch of messages. Returns results indexed by input position. */
export function decryptBatch(messages: BatchDecryptInput[]): Promise<BatchDecryptResult[]> {
  return invoke<BatchDecryptResult[]>('crypto_decrypt_batch', { messages })
}

/** Generate a deterministic safety number for identity verification. */
export function generateSafetyNumber(
  ourIdentityKey: string,
  theirIdentityKey: string,
): Promise<string> {
  return invoke<string>('crypto_generate_safety_number', {
    ourIdentityKey,
    theirIdentityKey,
  })
}
