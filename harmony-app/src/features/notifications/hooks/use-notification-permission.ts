import { useCallback, useEffect, useState } from 'react'
import { logger } from '@/lib/logger'
import { isTauri } from '@/lib/platform'

export type NotificationPermissionState = 'granted' | 'denied' | 'default' | 'unsupported'

function readWebPermission(): NotificationPermissionState {
  if (typeof Notification === 'undefined') return 'unsupported'
  return Notification.permission
}

/**
 * Notification permission state machine (web Notification API / Tauri plugin).
 *
 * NEVER-NAG INVARIANT: `request()` is invoked from exactly two places — the
 * settings tab's enable action and the one-time banner. Nothing calls it on
 * mount, on SSE events, or on a timer. It MUST be called from a user gesture
 * (Chromium requires one for the prompt).
 */
export function useNotificationPermission(): {
  state: NotificationPermissionState
  request: () => Promise<NotificationPermissionState>
} {
  const [state, setState] = useState<NotificationPermissionState>(() =>
    isTauri() ? 'default' : readWebPermission(),
  )

  // WHY Tauri initial read: the plugin check is async — resolve it once on
  // mount ('default' maps to "not yet granted").
  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    void (async () => {
      try {
        const { isPermissionGranted } = await import('@tauri-apps/plugin-notification')
        const granted = await isPermissionGranted()
        if (!cancelled && granted) setState('granted')
      } catch (err: unknown) {
        logger.warn('notification_permission_check_failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // WHY visibilitychange re-check: covers the user unblocking (or revoking) in
  // browser site settings mid-session, or granting in another tab — no reload
  // needed.
  useEffect(() => {
    if (isTauri()) return

    function recheck() {
      setState(readWebPermission())
    }

    document.addEventListener('visibilitychange', recheck)
    return () => document.removeEventListener('visibilitychange', recheck)
  }, [])

  const request = useCallback(async (): Promise<NotificationPermissionState> => {
    if (isTauri()) {
      try {
        const { requestPermission } = await import('@tauri-apps/plugin-notification')
        const result = await requestPermission()
        const next: NotificationPermissionState = result === 'granted' ? 'granted' : 'denied'
        setState(next)
        logger.info('notification_permission_result', { result: next })
        return next
      } catch (err: unknown) {
        logger.warn('notification_permission_check_failed', {
          error: err instanceof Error ? err.message : String(err),
        })
        return 'denied'
      }
    }

    if (typeof Notification === 'undefined') return 'unsupported'
    const result = await Notification.requestPermission()
    setState(result)
    logger.info('notification_permission_result', { result })
    return result
  }, [])

  return { state, request }
}
