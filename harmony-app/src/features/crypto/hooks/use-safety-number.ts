/**
 * Safety number hook — generates a deterministic safety number for DM verification.
 *
 * WHY: Both users compute the same safety number (keys sorted before hashing).
 * Comparing this number out-of-band (in person, phone call) confirms identity.
 *
 * Only runs on desktop (isTauri() guard). On web, returns null.
 */

import { useEffect, useState } from 'react'
import { generateSafetyNumber } from '@/lib/crypto'
import { logger } from '@/lib/logger'
import { isTauri } from '@/lib/platform'
import { useCryptoStore } from '../stores/crypto-store'

interface UseSafetyNumberResult {
  safetyNumber: string | null
  isLoading: boolean
}

export function useSafetyNumber(recipientUserId: string | null): UseSafetyNumberResult {
  const [safetyNumber, setSafetyNumber] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  // WHY: Read the recipient's identity key from the local TOFU store.
  const theirIdentityKey = useCryptoStore((s) =>
    recipientUserId !== null ? s.getKnownIdentityKey(recipientUserId) : undefined,
  )

  useEffect(() => {
    if (!isTauri() || recipientUserId === null || theirIdentityKey === undefined) {
      setIsLoading(false)
      return
    }

    // WHY: Capture the narrowed value so TypeScript knows it's a string inside the async closure.
    const recipientKey = theirIdentityKey
    let cancelled = false

    // WHY: We need our own identity key from the crypto store.
    // The Tauri command handles the SHA-256 + formatting.
    async function compute() {
      try {
        const { getIdentityKeys } = await import('@/lib/crypto')
        const keys = await getIdentityKeys()
        const number = await generateSafetyNumber(keys.identity_key, recipientKey)

        if (!cancelled) {
          setSafetyNumber(number)
          setIsLoading(false)
        }
      } catch (err: unknown) {
        if (!cancelled) {
          logger.warn('Failed to generate safety number', {
            recipientUserId,
            error: String(err),
          })
          setIsLoading(false)
        }
      }
    }

    compute()

    return () => {
      cancelled = true
    }
  }, [recipientUserId, theirIdentityKey])

  return { safetyNumber, isLoading }
}
