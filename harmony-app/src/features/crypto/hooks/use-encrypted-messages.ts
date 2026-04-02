/**
 * Encrypted message handling hook — decrypt, cache, and display E2EE DM messages.
 *
 * WHY: Messages with `encrypted: true` contain ciphertext that must be decrypted
 * via the Tauri Olm runtime before display. This hook provides:
 * - `decryptMessage()`: decrypt a single message (handles pre-key vs normal)
 * - `decryptedCache`: Map<messageId, plaintext> for already-decrypted messages
 *
 * Sequential decryption is enforced per-session via the crypto queue
 * (src/features/crypto/crypto-queue.ts) to protect Olm ratchet state.
 *
 * On web: messages with `encrypted: true` display a placeholder banner.
 */

import { useCallback, useRef } from 'react'
import { z } from 'zod'
import type { MessageResponse } from '@/lib/api'
import { decrypt } from '@/lib/crypto'
import { cacheMessage, getCachedMessages } from '@/lib/crypto-cache'
import { logger } from '@/lib/logger'
import { isTauri } from '@/lib/platform'
import { enqueueForSession } from '../crypto-queue'
import { useCryptoStore } from '../stores/crypto-store'
import { useCryptoSession } from './use-crypto-session'

/** WHY: Pre-key messages (type 0) require inbound session creation before decryption. */
const PRE_KEY_MESSAGE_TYPE = 0

// TODO: Refactor to discriminated union { status: 'success', plaintext } | { status: 'error', error }
// Current shape allows impossible states (both null, or both non-null)
export interface DecryptResult {
  plaintext: string | null
  /** WHY: Non-null when decryption failed — displayed as error state in UI. */
  error: string | null
  /** WHY: True when the sender's identity key changed since last session. */
  identityKeyChanged: boolean
}

const encryptedEnvelopeSchema = z.object({
  message_type: z.number(),
  ciphertext: z.string(),
})

type EncryptedEnvelope = z.infer<typeof encryptedEnvelopeSchema>

/**
 * Parse the encrypted envelope stored in `message.content`.
 * WHY: The sender stores a JSON envelope with message_type + ciphertext
 * as the message content field when `encrypted: true`.
 */
function parseEncryptedEnvelope(content: string): EncryptedEnvelope {
  const parsed: unknown = JSON.parse(content)
  const result = encryptedEnvelopeSchema.safeParse(parsed)
  if (result.success) {
    return result.data
  }
  throw new Error('Invalid encrypted message envelope')
}

/**
 * WHY extracted: Decrypt a normal (non-pre-key) Olm message using an existing session.
 * Returns null if no session exists for this sender. Enqueues to prevent ratchet corruption.
 */
async function decryptNormalMessage(
  authorId: string,
  envelope: EncryptedEnvelope,
): Promise<string | null> {
  const sessionId = useCryptoStore.getState().getSession(authorId)
  if (sessionId === undefined) return null

  return enqueueForSession(sessionId, () =>
    decrypt(sessionId, envelope.message_type, envelope.ciphertext),
  )
}

export function useEncryptedMessages() {
  // WHY: In-memory cache of decrypted plaintext keyed by message ID.
  // Avoids redundant Tauri invoke() calls for messages already decrypted this session.
  const decryptedCache = useRef(new Map<string, string>())
  const { createInbound } = useCryptoSession()

  /**
   * Decrypt a single encrypted message. Handles both pre-key (first message)
   * and normal Olm messages. Results are cached in memory and SQLCipher.
   */
  const decryptMessage = useCallback(
    async (message: MessageResponse, senderIdentityKey?: string): Promise<DecryptResult> => {
      if (!isTauri()) {
        return { plaintext: null, error: 'desktop_required', identityKeyChanged: false }
      }

      if (message.encrypted !== true) {
        return { plaintext: message.content, error: null, identityKeyChanged: false }
      }

      const cached = decryptedCache.current.get(message.id)
      if (cached !== undefined) {
        return { plaintext: cached, error: null, identityKeyChanged: false }
      }

      return performDecryption(message, senderIdentityKey, decryptedCache.current, createInbound)
    },
    [createInbound],
  )

  /**
   * Pre-warm the in-memory cache from SQLCipher for a channel.
   * WHY: Avoids re-decrypting messages that were already decrypted in a previous session.
   */
  const loadCachedDecryptions = useCallback(async (channelId: string): Promise<void> => {
    if (!isTauri()) return

    try {
      const cached = await getCachedMessages(channelId)
      for (const msg of cached) {
        decryptedCache.current.set(msg.message_id, msg.plaintext)
      }
    } catch (error) {
      logger.warn('Failed to load cached decryptions', {
        channelId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }, [])

  /** Get cached plaintext for a message (no async, no side effects). */
  const getCachedPlaintext = useCallback((messageId: string): string | undefined => {
    return decryptedCache.current.get(messageId)
  }, [])

  /** WHY: Allows the sender to cache their own message's plaintext in-memory.
   * The sender cannot decrypt their own Olm message (asymmetric encryption),
   * so the plaintext must be cached at send time for immediate display. */
  const setCachedPlaintext = useCallback((messageId: string, plaintext: string) => {
    decryptedCache.current.set(messageId, plaintext)
  }, [])

  return { decryptMessage, loadCachedDecryptions, getCachedPlaintext, setCachedPlaintext }
}

type CreateInboundFn = (
  senderUserId: string,
  senderIdentityKey: string,
  preKeyMessage: string,
) => Promise<{ sessionId: string; plaintext: string; identityKeyChanged: boolean }>

/**
 * WHY extracted: Performs the full decrypt + cache pipeline outside the useCallback
 * to keep the hook's cognitive complexity below Biome's limit of 15.
 */
async function performDecryption(
  message: MessageResponse,
  senderIdentityKey: string | undefined,
  cache: Map<string, string>,
  createInbound: CreateInboundFn,
): Promise<DecryptResult> {
  try {
    const envelope = parseEncryptedEnvelope(message.content)
    const result = await decryptEnvelope(
      envelope,
      message.authorId,
      senderIdentityKey,
      createInbound,
    )

    if (result === null) {
      return { plaintext: null, error: 'no_session', identityKeyChanged: false }
    }

    cache.set(message.id, result.plaintext)
    cacheMessage(message.id, message.channelId, result.plaintext, message.createdAt).catch(
      (cacheError: unknown) => {
        logger.warn('Failed to cache decrypted message', {
          messageId: message.id,
          error: cacheError instanceof Error ? cacheError.message : String(cacheError),
        })
      },
    )

    return { plaintext: result.plaintext, error: null, identityKeyChanged: result.keyChanged }
  } catch (error) {
    logger.error('Message decryption failed', {
      messageId: message.id,
      error: error instanceof Error ? error.message : String(error),
    })
    return {
      plaintext: null,
      error: error instanceof Error ? error.message : 'decryption_failed',
      identityKeyChanged: false,
    }
  }
}

/**
 * WHY extracted: Core decryption dispatch — handles pre-key vs normal message types.
 * Returns null when no session exists for normal messages (caller handles the error).
 */
async function decryptEnvelope(
  envelope: EncryptedEnvelope,
  authorId: string,
  senderIdentityKey: string | undefined,
  createInbound: CreateInboundFn,
): Promise<{ plaintext: string; keyChanged: boolean } | null> {
  if (envelope.message_type === PRE_KEY_MESSAGE_TYPE) {
    if (senderIdentityKey === undefined) {
      logger.warn('pre_key_message_missing_identity_key', { authorId })
      return null
    }
    const result = await createInbound(authorId, senderIdentityKey, envelope.ciphertext)
    return { plaintext: result.plaintext, keyChanged: result.identityKeyChanged }
  }

  const plaintext = await decryptNormalMessage(authorId, envelope)
  if (plaintext === null) return null

  return { plaintext, keyChanged: false }
}
