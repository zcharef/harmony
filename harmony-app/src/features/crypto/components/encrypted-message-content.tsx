/**
 * Encrypted message content renderer — decrypts or shows placeholder.
 *
 * WHY: When a message has `encrypted: true`, the `content` field contains
 * ciphertext. On desktop, this component decrypts it inline. On web,
 * it shows a locked placeholder. Follows the MessageItem content rendering
 * pattern (src/features/chat/message-item.tsx:117-181).
 */

import { Chip, Spinner } from '@heroui/react'
import { Lock } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MessageResponse } from '@/lib/api'
import { logger } from '@/lib/logger'
import { isTauri } from '@/lib/platform'
import type { DecryptResult } from '../hooks/use-encrypted-messages'

interface EncryptedMessageContentProps {
  message: MessageResponse
  /** WHY: Provided by parent that owns the useEncryptedMessages hook. */
  decryptMessage: (message: MessageResponse, senderIdentityKey?: string) => Promise<DecryptResult>
  /** WHY: Fast synchronous lookup for already-decrypted messages. */
  getCachedPlaintext: (messageId: string) => string | undefined
}

type DecryptionStatus = 'pending' | 'decrypted' | 'error' | 'web_fallback'

export function EncryptedMessageContent({
  message,
  decryptMessage,
  getCachedPlaintext,
}: EncryptedMessageContentProps) {
  const { t } = useTranslation('crypto')

  // WHY: Try synchronous cache first to avoid flash-of-loading for already-decrypted messages.
  const cachedPlaintext = getCachedPlaintext(message.id)

  const [status, setStatus] = useState<DecryptionStatus>(
    cachedPlaintext !== undefined ? 'decrypted' : isTauri() ? 'pending' : 'web_fallback',
  )
  const [plaintext, setPlaintext] = useState<string | null>(cachedPlaintext ?? null)
  const [identityKeyChanged, setIdentityKeyChanged] = useState(false)

  useEffect(() => {
    // WHY: Already decrypted from cache — nothing to do.
    if (cachedPlaintext !== undefined) return
    // WHY: Web client cannot decrypt — show placeholder.
    if (!isTauri()) return

    let cancelled = false

    async function doDecrypt() {
      const result = await decryptMessage(message)
      if (cancelled) return

      if (result.plaintext !== null) {
        setPlaintext(result.plaintext)
        setStatus('decrypted')
        setIdentityKeyChanged(result.identityKeyChanged)
      } else {
        logger.warn('message_decryption_failed', {
          messageId: message.id,
          error: result.error,
        })
        setStatus('error')
      }
    }

    doDecrypt()

    return () => {
      cancelled = true
    }
  }, [message, cachedPlaintext, decryptMessage])

  if (status === 'web_fallback') {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm italic text-default-400">
        <Lock className="h-3.5 w-3.5" />
        {t('encryptedWebFallback')}
      </span>
    )
  }

  if (status === 'pending') {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-default-400">
        <Spinner size="sm" />
        {t('decrypting')}
      </span>
    )
  }

  if (status === 'error') {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm italic text-danger-400">
        <Lock className="h-3.5 w-3.5" />
        {t('decryptionFailed')}
      </span>
    )
  }

  return (
    <>
      <span className="text-sm text-foreground/90">{plaintext}</span>
      {identityKeyChanged && (
        <Chip color="warning" size="sm" variant="flat" className="ml-1">
          {t('identityKeyChanged')}
        </Chip>
      )}
    </>
  )
}
