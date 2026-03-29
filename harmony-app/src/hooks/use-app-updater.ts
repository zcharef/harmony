/**
 * Auto-update hook for the Tauri desktop app.
 *
 * WHY: The Tauri updater Rust plugin is registered (lib.rs:37) and capabilities
 * are granted (capabilities/default.json:11-12), but auto-updates don't happen
 * without explicit JS calls. This hook provides the check → download → prompt flow.
 *
 * Behavior:
 * - Cold start: check immediately → download + install → relaunch (transparent).
 *   If relaunch fails, falls through to showing the notification.
 * - Already running: periodic check (30 min) → download → show prompt → user restarts
 * - Web browser: no-op (isTauri() guard)
 * - Background errors: logger.warn (ADR-045). User-action errors: logger.error + toast.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { logger } from '@/lib/logger'
import { isTauri } from '@/lib/platform'
import { toast } from '@/lib/toast'

type UpdateStatus = 'idle' | 'checking' | 'downloading' | 'ready'

interface AppUpdaterState {
  status: UpdateStatus
  version: string | null
  restart: () => void
  dismiss: () => void
  dismissed: boolean
}

type CheckResult = { kind: 'up_to_date' } | { kind: 'ready'; version: string }

const CHECK_INTERVAL_MS = 30 * 60 * 1000 // 30 minutes

/** Check for updates, download, and optionally auto-relaunch. */
async function checkForUpdate(
  onStatus: (s: UpdateStatus) => void,
  isStartup: boolean,
): Promise<CheckResult> {
  // WHY: Dynamic import — @tauri-apps/plugin-updater crashes in the browser.
  const { check } = await import('@tauri-apps/plugin-updater')

  onStatus('checking')
  const update = await check()

  if (!update) {
    return { kind: 'up_to_date' }
  }

  logger.info('update_available', { version: update.version })
  onStatus('downloading')

  await update.downloadAndInstall((progress) => {
    if (progress.event === 'Finished') {
      logger.info('update_downloaded', { version: update.version })
    }
  })

  // WHY: On cold start, try to auto-relaunch seamlessly. If relaunch fails,
  // fall through to return 'ready' so the notification UI appears instead
  // of silently dropping the downloaded update.
  if (isStartup) {
    try {
      const { relaunch } = await import('@tauri-apps/plugin-process')
      logger.info('update_auto_relaunch', { version: update.version })
      await relaunch()
    } catch (err: unknown) {
      logger.warn('update_auto_relaunch_failed', {
        version: update.version,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return { kind: 'ready', version: update.version }
}

export function useAppUpdater(isAppReady: boolean): AppUpdaterState {
  const [status, setStatus] = useState<UpdateStatus>('idle')
  const [version, setVersion] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const hasCheckedOnce = useRef(false)
  // WHY: Async operations (downloadAndInstall, relaunch) can resolve after
  // the component unmounts. Guard state updates to avoid stale writes.
  const mountedRef = useRef(true)

  useEffect(() => {
    return () => {
      mountedRef.current = false
    }
  }, [])

  // WHY: Wraps setStatus with a mounted guard so checkAndApply stays under
  // Biome's cognitive complexity limit of 15.
  const safeSetStatus = useCallback((s: UpdateStatus) => {
    if (mountedRef.current) setStatus(s)
  }, [])

  const checkAndApply = useCallback(
    async (isStartup: boolean) => {
      if (!isTauri()) return

      try {
        const result = await checkForUpdate((s) => {
          safeSetStatus(s)
        }, isStartup)

        if (!mountedRef.current) return

        if (result.kind === 'up_to_date') {
          logger.info('update_check_complete', { result: 'up_to_date' })
          safeSetStatus('idle')
          return
        }

        setVersion(result.version)
        setDismissed(false)
        safeSetStatus('ready')
      } catch (err: unknown) {
        logger.warn('update_check_failed', {
          error: err instanceof Error ? err.message : String(err),
        })
        safeSetStatus('idle')
      }
    },
    [safeSetStatus],
  )

  // WHY: logger.error + toast because restart is an explicit user action (ADR-045).
  const restart = useCallback(async () => {
    if (!isTauri()) return
    try {
      const { relaunch } = await import('@tauri-apps/plugin-process')
      await relaunch()
    } catch (err: unknown) {
      toast.error('Failed to restart — please restart manually')
      logger.error('update_relaunch_failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }, [])

  // WHY: Only hides the notification for this cycle. Status stays 'ready'
  // so the periodic interval won't re-trigger a download, but the next
  // interval tick after dismiss timeout will show the notification again.
  const dismiss = useCallback(() => {
    setDismissed(true)
  }, [])

  // Startup check — runs once when the app is ready
  useEffect(() => {
    if (!isTauri() || !isAppReady || hasCheckedOnce.current) return
    hasCheckedOnce.current = true
    checkAndApply(true)
  }, [isAppReady, checkAndApply])

  // Periodic check — every 30 minutes while the app is open
  // WHY: Only triggers when status is 'idle' (no update pending).
  // When status is 'ready' (update downloaded, waiting for restart),
  // the interval skips the check but still runs — so if the user
  // dismissed the notification, we can re-show it.
  useEffect(() => {
    if (!isTauri() || !isAppReady) return

    const interval = setInterval(() => {
      if (status === 'idle') {
        checkAndApply(false)
      } else if (status === 'ready' && dismissed) {
        setDismissed(false)
      }
    }, CHECK_INTERVAL_MS)

    return () => clearInterval(interval)
  }, [isAppReady, status, dismissed, checkAndApply])

  return { status, version, restart, dismiss, dismissed }
}
