/**
 * Auto-update hook for the Tauri desktop app.
 *
 * WHY: The Tauri updater Rust plugin is registered (lib.rs:37) and capabilities
 * are granted (capabilities/default.json:11-12), but auto-updates don't happen
 * without explicit JS calls. This hook provides the check → download → prompt flow.
 *
 * Behavior:
 * - Cold start: check immediately → download in background → show prompt → user restarts
 * - Already running: periodic check (30 min) → download → show prompt → user restarts
 * - App closed before restart: Tauri applies the downloaded update on next launch
 * - Web browser: no-op (isTauri() guard)
 * - Background errors: logger.warn (ADR-045). User-action errors: logger.error + toast.
 *
 * WHY download() + install() instead of downloadAndInstall():
 * downloadAndInstall() replaces the app binary immediately on macOS, killing
 * the running process before the user ever sees the restart prompt. Splitting
 * into download() (background) + install() (on user confirmation) ensures the
 * user is always prompted first.
 */

import type { Update } from '@tauri-apps/plugin-updater'
import i18n from 'i18next'
import { useCallback, useEffect, useRef, useState } from 'react'
import { logger } from '@/lib/logger'
import { isTauri } from '@/lib/platform'
import { toast } from '@/lib/toast'

type UpdateStatus = 'idle' | 'checking' | 'downloading' | 'ready'

interface UpdateInfo {
  version: string
  currentVersion: string
  body: string | null
  date: string | null
}

export interface AppUpdaterState {
  status: UpdateStatus
  updateInfo: UpdateInfo | null
  restart: () => void
  dismiss: () => void
  dismissed: boolean
}

type CheckResult = { kind: 'up_to_date' } | { kind: 'ready'; info: UpdateInfo; update: Update }

const CHECK_INTERVAL_MS = 30 * 60 * 1000 // 30 minutes

/** Check for updates and download only. Never installs — that's the user's choice. */
async function checkAndDownload(onStatus: (s: UpdateStatus) => void): Promise<CheckResult> {
  // WHY: Dynamic import — @tauri-apps/plugin-updater crashes in the browser.
  const { check } = await import('@tauri-apps/plugin-updater')

  onStatus('checking')
  const update = await check()

  if (!update) {
    return { kind: 'up_to_date' }
  }

  logger.info('update_available', {
    version: update.version,
    currentVersion: update.currentVersion,
  })
  onStatus('downloading')

  // WHY: download() stages the update without installing. If the user closes
  // the app, Tauri applies it on next launch. If the app stays open, we
  // prompt the user and call install() only on confirmation.
  await update.download((progress) => {
    if (progress.event === 'Finished') {
      logger.info('update_downloaded', { version: update.version })
    }
  })

  return {
    kind: 'ready',
    update,
    info: {
      version: update.version,
      currentVersion: update.currentVersion,
      body: update.body ?? null,
      date: update.date ?? null,
    },
  }
}

export function useAppUpdater(isAppReady: boolean): AppUpdaterState {
  const [status, setStatus] = useState<UpdateStatus>('idle')
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const hasCheckedOnce = useRef(false)
  // WHY: install() requires the same Update instance that called download(),
  // because downloadedBytes is an instance property. A fresh check() returns
  // a new object with downloadedBytes=undefined, which makes install() throw.
  const pendingUpdateRef = useRef<Update | null>(null)
  // WHY: Async operations (download, relaunch) can resolve after
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

  const checkAndApply = useCallback(async () => {
    if (!isTauri()) return

    try {
      const result = await checkAndDownload((s) => {
        safeSetStatus(s)
      })

      if (!mountedRef.current) return

      if (result.kind === 'up_to_date') {
        logger.info('update_check_complete', { result: 'up_to_date' })
        safeSetStatus('idle')
        return
      }

      pendingUpdateRef.current = result.update
      setUpdateInfo(result.info)
      setDismissed(false)
      safeSetStatus('ready')
    } catch (err: unknown) {
      logger.warn('update_check_failed', {
        error: err instanceof Error ? err.message : String(err),
      })
      safeSetStatus('idle')
    }
  }, [safeSetStatus])

  // WHY: install() + relaunch() only on explicit user confirmation.
  // logger.error + toast because restart is an explicit user action (ADR-045).
  const restart = useCallback(async () => {
    if (!isTauri()) return
    try {
      // WHY: install() must be called on the same Update instance that called
      // download(), because downloadedBytes is an instance property. A fresh
      // check() would return a new object with downloadedBytes=undefined.
      const update = pendingUpdateRef.current
      if (update) {
        await update.install()
      }
      const { relaunch } = await import('@tauri-apps/plugin-process')
      await relaunch()
    } catch (err: unknown) {
      toast.error(i18n.t('common:restartFailed'))
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
    checkAndApply()
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
        checkAndApply()
      } else if (status === 'ready' && dismissed) {
        setDismissed(false)
      }
    }, CHECK_INTERVAL_MS)

    return () => clearInterval(interval)
  }, [isAppReady, status, dismissed, checkAndApply])

  return { status, updateInfo, restart, dismiss, dismissed }
}
