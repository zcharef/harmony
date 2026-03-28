/**
 * Olm session management hook — establishes encrypted sessions with DM recipients.
 *
 * WHY: Before encrypting/decrypting a DM, an Olm session must exist between
 * the local device and the recipient's device. This hook manages session
 * lifecycle: lookup existing session, or create one from a pre-key bundle.
 *
 * Key change detection: When establishing a new session, the recipient's
 * identity key is compared against the previously stored key. A mismatch
 * triggers a key change warning (potential MITM or device replacement).
 */

import { useCallback, useRef } from 'react'
import { getPreKeyBundle } from '@/lib/api'
import { createInboundSession, createOutboundSession } from '@/lib/crypto'
import { logger } from '@/lib/logger'
import { isTauri } from '@/lib/platform'
import { useCryptoStore } from '../stores/crypto-store'

interface EnsureSessionResult {
  sessionId: string
  /** WHY: True when the recipient's identity key differs from the stored one. */
  identityKeyChanged: boolean
}

export function useCryptoSession() {
  // WHY: Ref to serialize concurrent ensureSession calls for the same recipient.
  // Prevents duplicate pre-key bundle claims when multiple messages arrive at once.
  const pendingEnsure = useRef(new Map<string, Promise<EnsureSessionResult>>())

  const ensureSession = useCallback(
    async (recipientUserId: string): Promise<EnsureSessionResult> => {
      if (!isTauri()) {
        throw new Error('E2EE sessions require desktop app')
      }

      // WHY: If a session already exists locally, reuse it (no network call).
      const existing = useCryptoStore.getState().getSession(recipientUserId)
      if (existing !== undefined) {
        return { sessionId: existing, identityKeyChanged: false }
      }

      // WHY: Deduplicate concurrent ensureSession calls for the same recipient.
      const pending = pendingEnsure.current.get(recipientUserId)
      if (pending !== undefined) {
        return pending
      }

      const promise = establishSession(recipientUserId)
      pendingEnsure.current.set(recipientUserId, promise)

      try {
        return await promise
      } finally {
        pendingEnsure.current.delete(recipientUserId)
      }
    },
    [],
  )

  /**
   * Create an inbound session from a pre-key message received from a sender.
   * WHY: The first message from a new sender is a pre-key message (message_type === 0).
   * We must create an inbound session before we can decrypt it.
   */
  const createInbound = useCallback(
    async (
      senderUserId: string,
      senderIdentityKey: string,
      preKeyMessage: string,
    ): Promise<{ sessionId: string; plaintext: string; identityKeyChanged: boolean }> => {
      if (!isTauri()) {
        throw new Error('E2EE sessions require desktop app')
      }

      const result = await createInboundSession(senderIdentityKey, preKeyMessage)

      const identityKeyChanged = checkIdentityKeyChange(senderUserId, senderIdentityKey)

      useCryptoStore.getState().setSession(senderUserId, result.session_id)
      useCryptoStore.getState().setKnownIdentityKey(senderUserId, senderIdentityKey)

      logger.info('Inbound Olm session created', {
        senderUserId,
        sessionId: result.session_id,
        identityKeyChanged,
      })

      return {
        sessionId: result.session_id,
        plaintext: result.plaintext,
        identityKeyChanged,
      }
    },
    [],
  )

  return { ensureSession, createInbound }
}

/**
 * Fetch pre-key bundle and create outbound Olm session.
 * WHY separated: Keeps the hook callback lean and testable.
 */
async function establishSession(recipientUserId: string): Promise<EnsureSessionResult> {
  // WHY: Atomically claims a one-time key from the server (or falls back to fallback key).
  const { data: bundle } = await getPreKeyBundle({
    path: { user_id: recipientUserId },
    throwOnError: true,
  })

  // WHY: Prefer one-time key; fall back to fallback key if one-time keys are exhausted.
  const preKey = bundle.oneTimeKey ?? bundle.fallbackKey
  if (preKey === undefined || preKey === null) {
    throw new Error(`No pre-keys available for user ${recipientUserId}`)
  }

  const sessionId = await createOutboundSession(bundle.identityKey, preKey.publicKey)

  const identityKeyChanged = checkIdentityKeyChange(recipientUserId, bundle.identityKey)

  useCryptoStore.getState().setSession(recipientUserId, sessionId)
  useCryptoStore.getState().setKnownIdentityKey(recipientUserId, bundle.identityKey)

  logger.info('Outbound Olm session created', {
    recipientUserId,
    sessionId,
    identityKeyChanged,
  })

  return { sessionId, identityKeyChanged }
}

/**
 * Compare a user's current identity key with the stored one.
 * Returns true if the key changed (potential device replacement or MITM).
 */
function checkIdentityKeyChange(userId: string, currentIdentityKey: string): boolean {
  const stored = useCryptoStore.getState().getKnownIdentityKey(userId)
  if (stored === undefined) return false
  return stored !== currentIdentityKey
}
