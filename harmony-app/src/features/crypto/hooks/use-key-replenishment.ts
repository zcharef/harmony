/**
 * Key replenishment hook — maintains a healthy supply of one-time pre-keys.
 *
 * WHY: Each Olm session establishment consumes one one-time key. If the supply
 * runs out, new sessions fall back to the (less secure) fallback key. This hook
 * periodically checks the remaining count and uploads fresh keys when low.
 *
 * Only runs on desktop (isTauri() guard). Polling interval: 5 minutes.
 * Threshold: replenish when count drops below 25 keys.
 */

import { useEffect, useRef } from 'react'
import { getKeyCount, uploadOneTimeKeys } from '@/lib/api'
import { generateOneTimeKeys } from '@/lib/crypto'
import { logger } from '@/lib/logger'
import { isTauri } from '@/lib/platform'
import { useCryptoStore } from '../stores/crypto-store'

/** WHY: 25 is half the initial batch of 50 — replenish before exhaustion. */
const LOW_KEY_THRESHOLD = 25
const REPLENISH_COUNT = 50
const CHECK_INTERVAL_MS = 5 * 60 * 1000

export function useKeyReplenishment(): void {
  const isInitialized = useCryptoStore((s) => s.isInitialized)
  const deviceId = useCryptoStore((s) => s.deviceId)
  const isReplenishing = useRef(false)

  useEffect(() => {
    if (!isTauri()) return
    if (!isInitialized) return
    if (deviceId === null) return

    async function checkAndReplenish(currentDeviceId: string): Promise<void> {
      if (isReplenishing.current) return
      isReplenishing.current = true

      try {
        const { data } = await getKeyCount({
          query: { device_id: currentDeviceId },
          throwOnError: true,
        })

        if (data.count >= LOW_KEY_THRESHOLD) return

        logger.info('One-time key count low, replenishing', {
          currentCount: data.count,
          deviceId: currentDeviceId,
        })

        const newKeys = await generateOneTimeKeys(REPLENISH_COUNT)

        const keysToUpload = newKeys.map((key) => ({
          keyId: key.key_id,
          publicKey: key.public_key,
          isFallback: false,
        }))

        await uploadOneTimeKeys({
          body: {
            deviceId: currentDeviceId,
            keys: keysToUpload,
          },
          throwOnError: true,
        })

        logger.info('One-time keys replenished', {
          uploadedCount: keysToUpload.length,
          deviceId: currentDeviceId,
        })
      } catch (error) {
        // WHY: Background operation — don't show user feedback (ADR-045).
        // Will retry on next interval.
        logger.error('Key replenishment failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      } finally {
        isReplenishing.current = false
      }
    }

    // WHY: Run immediately on mount, then periodically.
    checkAndReplenish(deviceId)
    const interval = setInterval(() => checkAndReplenish(deviceId), CHECK_INTERVAL_MS)

    return () => clearInterval(interval)
  }, [isInitialized, deviceId])
}
