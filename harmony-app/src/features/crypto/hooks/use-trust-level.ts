/**
 * Trust level hook — reads and writes the local trust level for a given user.
 *
 * WHY: Trust levels are stored locally in SQLCipher (the server never knows
 * who you've verified). This hook wraps the Tauri invoke calls and caches
 * the result in React state to avoid redundant IPC on every render.
 *
 * Only runs on desktop (isTauri() guard). On web, returns "unverified" always.
 */

import { useCallback, useEffect, useState } from 'react'
import type { TrustLevel } from '@/lib/crypto-cache'
import { getTrustLevel, setTrustLevel } from '@/lib/crypto-cache'
import { logger } from '@/lib/logger'
import { isTauri } from '@/lib/platform'

interface UseTrustLevelResult {
  trustLevel: TrustLevel
  /** WHY: True during the initial load from SQLCipher. */
  isLoading: boolean
  setLevel: (level: TrustLevel) => Promise<void>
}

export function useTrustLevel(userId: string | null): UseTrustLevelResult {
  const [trustLevel, setTrustLevelState] = useState<TrustLevel>('unverified')
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    if (!isTauri() || userId === null) {
      setIsLoading(false)
      return
    }

    let cancelled = false

    getTrustLevel(userId)
      .then((level) => {
        if (!cancelled) {
          setTrustLevelState(level)
          setIsLoading(false)
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          logger.warn('Failed to load trust level', { userId, error: String(err) })
          setIsLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [userId])

  const setLevel = useCallback(
    async (level: TrustLevel) => {
      if (!isTauri() || userId === null) return

      try {
        await setTrustLevel(userId, level)
        setTrustLevelState(level)
        logger.info('trust_level_updated', { userId, level })
      } catch (err: unknown) {
        logger.error('set_trust_level_failed', {
          userId,
          level,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
    [userId],
  )

  return { trustLevel, isLoading, setLevel }
}
