/**
 * Channel-level E2EE hook — manages Megolm encrypt/decrypt for encrypted channels.
 *
 * WHY: Encrypted channels use Megolm (group encryption) instead of Olm (1:1).
 * This hook provides the same interface pattern as useDmEncryption in chat-area.tsx
 * but backed by Megolm sessions instead of Olm sessions.
 *
 * On web: encryption functions are unavailable — callers show fallback banners.
 * On desktop: encrypts outbound messages and decrypts inbound messages using
 * the Megolm session established when the channel's E2EE was enabled.
 */

import { useCallback, useRef } from 'react'
import { z } from 'zod'
import type { MessageResponse } from '@/lib/api'
import { cacheMessage, getCachedMessages } from '@/lib/crypto-cache'
import { megolmDecrypt, megolmEncrypt } from '@/lib/crypto-megolm'
import { logger } from '@/lib/logger'
import { isTauri } from '@/lib/platform'
import type { DecryptResult } from './use-encrypted-messages'

export interface ChannelEncryptResult {
  /** WHY: JSON envelope containing session_id + ciphertext for the API. */
  content: string
  senderDeviceId: string
}

/**
 * WHY: Parse the Megolm encrypted envelope stored in message.content.
 * The sender stores { session_id, ciphertext } as JSON in the content field.
 */
const megolmEnvelopeSchema = z.object({
  session_id: z.string(),
  ciphertext: z.string(),
})

type MegolmEnvelope = z.infer<typeof megolmEnvelopeSchema>

function parseMegolmEnvelope(content: string): MegolmEnvelope {
  const parsed: unknown = JSON.parse(content)
  const result = megolmEnvelopeSchema.safeParse(parsed)
  if (result.success) {
    return result.data
  }
  throw new Error('Invalid Megolm encrypted message envelope')
}

export function useChannelEncryption() {
  // WHY: In-memory cache of decrypted plaintext keyed by message ID.
  // Same pattern as useEncryptedMessages for DM decryption.
  const decryptedCache = useRef(new Map<string, string>())

  /**
   * Encrypt a plaintext message for an encrypted channel.
   * Returns the encrypted content envelope + device ID for the API.
   */
  const encryptChannelMessage = useCallback(
    async (
      channelId: string,
      plaintext: string,
      deviceId: string,
    ): Promise<ChannelEncryptResult> => {
      if (!isTauri()) throw new Error('Channel encryption requires desktop app')
      const encrypted = await megolmEncrypt(channelId, plaintext)
      const content = JSON.stringify({
        session_id: encrypted.session_id,
        ciphertext: encrypted.ciphertext,
      })
      return { content, senderDeviceId: deviceId }
    },
    [],
  )

  /**
   * Decrypt a single encrypted channel message.
   * WHY: Same DecryptResult interface as DM decryption for consistent UI rendering.
   */
  const decryptChannelMessage = useCallback(
    async (message: MessageResponse): Promise<DecryptResult> => {
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

      try {
        const envelope = parseMegolmEnvelope(message.content)
        const plaintext = await megolmDecrypt(
          message.channelId,
          envelope.session_id,
          envelope.ciphertext,
        )

        decryptedCache.current.set(message.id, plaintext)
        cacheMessage(message.id, message.channelId, plaintext, message.createdAt).catch(
          (cacheError: unknown) => {
            logger.warn('Failed to cache decrypted channel message', {
              messageId: message.id,
              error: cacheError instanceof Error ? cacheError.message : String(cacheError),
            })
          },
        )

        return { plaintext, error: null, identityKeyChanged: false }
      } catch (error) {
        logger.error('Channel message decryption failed', {
          messageId: message.id,
          channelId: message.channelId,
          error: error instanceof Error ? error.message : String(error),
        })
        return {
          plaintext: null,
          error: error instanceof Error ? error.message : 'decryption_failed',
          identityKeyChanged: false,
        }
      }
    },
    [],
  )

  /**
   * Pre-warm the in-memory cache from SQLCipher for an encrypted channel.
   * WHY: Same pattern as loadCachedDecryptions in useEncryptedMessages.
   */
  const loadCachedChannelDecryptions = useCallback(async (channelId: string): Promise<void> => {
    if (!isTauri()) return

    try {
      const cached = await getCachedMessages(channelId)
      for (const msg of cached) {
        decryptedCache.current.set(msg.message_id, msg.plaintext)
      }
    } catch (error) {
      logger.warn('Failed to load cached channel decryptions', {
        channelId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }, [])

  /** Get cached plaintext for a message (no async, no side effects). */
  const getCachedPlaintext = useCallback((messageId: string): string | undefined => {
    return decryptedCache.current.get(messageId)
  }, [])

  return {
    encryptChannelMessage,
    decryptChannelMessage,
    loadCachedChannelDecryptions,
    getCachedPlaintext,
  }
}
