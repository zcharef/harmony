/**
 * Crypto initialization hook — bootstraps E2EE on login (desktop only).
 *
 * WHY: On desktop (isTauri()), after auth completes we must:
 * 1. Initialize the Olm machine (vodozemac) with the user's identity
 * 2. Register the device with the server (POST /v1/keys/device)
 * 3. Upload initial one-time keys (POST /v1/keys/one-time)
 * 4. Initialize the local SQLCipher message cache
 *
 * This hook runs once per auth session. It does NOT block login — errors
 * are logged but the app continues to work (channels, servers still function).
 * Only DM encryption will be unavailable if init fails.
 *
 * Follows the AuthProvider pattern (src/features/auth/auth-provider.tsx:42-71)
 * where side effects run in useEffect after auth state is established.
 */

import { useEffect, useRef } from 'react'
import { useAuthStore } from '@/features/auth'
import { registerDevice, uploadOneTimeKeys } from '@/lib/api'
import { initCrypto } from '@/lib/crypto'
import { initCache } from '@/lib/crypto-cache'
import { logger } from '@/lib/logger'
import { isTauri } from '@/lib/platform'
import { useCryptoStore } from '../stores/crypto-store'

export function useCryptoInit(): void {
  const user = useAuthStore((s) => s.user)
  const isLoading = useAuthStore((s) => s.isLoading)
  const { isInitialized, setInitialized, setInitFailed, setDeviceId } = useCryptoStore()
  const isInitializing = useRef(false)

  useEffect(() => {
    // WHY: Skip on web, during auth loading, if no user, or if already initialized.
    if (!isTauri()) return
    if (isLoading) return
    if (user === null) return
    if (isInitialized) return
    if (isInitializing.current) return

    isInitializing.current = true

    async function bootstrap(userId: string): Promise<void> {
      let step = 'init_olm'
      try {
        // Step 1: Initialize Olm machine — generates identity keys + initial one-time keys
        const keys = await initCrypto(userId)

        // Step 2: Generate a stable device ID (persisted in localStorage across sessions)
        step = 'device_id'
        let deviceId = useCryptoStore.getState().deviceId
        if (deviceId === null) {
          deviceId = crypto.randomUUID()
          setDeviceId(deviceId)
        }

        // Step 3: Register device with server (upserts on user_id + device_id)
        step = 'register_device'
        await registerDevice({
          body: {
            deviceId,
            deviceName: getDeviceName(),
            identityKey: keys.identity_key,
            signingKey: keys.signing_key,
          },
          throwOnError: true,
        })

        // Step 4: Upload initial one-time keys
        step = 'upload_keys'
        const oneTimeKeys = keys.one_time_keys.map((key) => ({
          keyId: key.key_id,
          publicKey: key.public_key,
          isFallback: false,
        }))

        if (oneTimeKeys.length > 0) {
          await uploadOneTimeKeys({
            body: {
              deviceId,
              keys: oneTimeKeys,
            },
            throwOnError: true,
          })
        }

        // Step 5: Initialize local message cache
        step = 'init_cache'
        await initCache(userId)

        setInitialized(true)
        logger.info('E2EE initialized', { deviceId, keyCount: oneTimeKeys.length })
      } catch (error) {
        // WHY: Don't block the app — E2EE is additive. Log and continue.
        // Set initFailed so the UI can warn users that DMs will be unencrypted.
        setInitFailed(true)
        logger.error('e2ee_init_failed', {
          step,
          error: error instanceof Error ? error.message : String(error),
        })
      } finally {
        isInitializing.current = false
      }
    }

    bootstrap(user.id)
  }, [user, isLoading, isInitialized, setInitialized, setInitFailed, setDeviceId])
}

/**
 * WHY: Best-effort device name for user recognition in device management UI.
 * Uses the User-Agent to derive a human-readable name. Falls back to "Desktop".
 */
function getDeviceName(): string {
  const ua = navigator.userAgent
  if (ua.includes('Mac')) return 'macOS Desktop'
  if (ua.includes('Windows')) return 'Windows Desktop'
  if (ua.includes('Linux')) return 'Linux Desktop'
  return 'Desktop'
}
