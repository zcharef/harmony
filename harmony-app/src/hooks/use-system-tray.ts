import i18n from 'i18next'
import { useEffect } from 'react'
import { useDesktopSettingsStore } from '@/features/settings'
import { logger } from '@/lib/logger'
import { isTauri } from '@/lib/platform'

/**
 * System tray + close-to-tray — desktop only (no-op on web).
 *
 * WHY built from JS (not Rust): the tray menu labels come from i18next and
 * the close-to-tray decision reads the desktop settings store — both live on
 * the frontend. Tauri's @tauri-apps/api/tray + menu APIs cover the whole
 * flow without custom Rust commands.
 *
 * WHY the tray exists regardless of the setting: it is the only way to
 * restore a hidden window and the discoverable place for "Quit". Only the
 * CloseRequested behavior is gated on the "Keep running in background"
 * setting (read at close time via getState() — always fresh).
 *
 * Pattern reference: desktop-auth.ts (dynamic import behind isTauri guard),
 * auth-provider.tsx (i18n.t outside components, cancelled-flag cleanup).
 */

const TRAY_ID = 'harmony-tray'

/** WHY module-level: the tray lives for the whole app lifetime — a once-flag
 * (instead of per-effect create/close) makes StrictMode's double-mounted
 * effect and any remount inherently race-free: the second run sees the flag
 * and returns before touching TrayIcon.new(). Reset only on setup failure so
 * a later mount can retry. */
let trayInitialized = false

async function toggleMainWindow(): Promise<void> {
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  const window = getCurrentWindow()
  const visible = await window.isVisible()
  if (visible) {
    await window.hide()
  } else {
    await window.show()
    await window.unminimize()
    await window.setFocus()
  }
}

async function quitApp(): Promise<void> {
  const { exit } = await import('@tauri-apps/plugin-process')
  await exit(0)
}

async function setupTray(): Promise<void> {
  const { TrayIcon } = await import('@tauri-apps/api/tray')

  // WHY getById guard: belt-and-braces on top of the module flag — e.g. a
  // Vite HMR module reset must not stack a duplicate tray.
  const existing = await TrayIcon.getById(TRAY_ID)
  if (existing !== null) return

  const { Menu } = await import('@tauri-apps/api/menu')
  const { defaultWindowIcon } = await import('@tauri-apps/api/app')

  const menu = await Menu.new({
    items: [
      {
        id: 'toggle-window',
        text: i18n.t('settings:trayShowHide'),
        action: () => {
          toggleMainWindow().catch((err: unknown) => {
            logger.warn('tray_toggle_window_failed', {
              error: err instanceof Error ? err.message : String(err),
            })
          })
        },
      },
      {
        id: 'quit',
        text: i18n.t('settings:trayQuit'),
        action: () => {
          quitApp().catch((err: unknown) => {
            logger.error('tray_quit_failed', {
              error: err instanceof Error ? err.message : String(err),
            })
          })
        },
      },
    ],
  })

  // WHY app icon: the spec is "reuse the app icon" — defaultWindowIcon
  // returns the bundled icon; null only if the bundle is misconfigured.
  const icon = await defaultWindowIcon()
  if (icon === null) {
    logger.warn('tray_default_icon_missing', {})
  }

  await TrayIcon.new({
    id: TRAY_ID,
    ...(icon !== null ? { icon } : {}),
    menu,
    tooltip: 'Harmony',
    showMenuOnLeftClick: true,
  })
}

export function useSystemTray(): void {
  // ── Tray icon + menu (created once per app lifetime) ─────────────
  useEffect(() => {
    if (!isTauri() || trayInitialized) return

    trayInitialized = true
    setupTray().catch((err: unknown) => {
      // WHY reset: allow a retry on the next mount instead of permanently
      // wedging the app in a tray-less state after a transient failure.
      trayInitialized = false
      logger.error('tray_setup_failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }, [])

  // ── Close-to-tray ────────────────────────────────────────────────
  useEffect(() => {
    if (!isTauri()) return

    let cancelled = false
    let unlisten: (() => void) | undefined

    async function setupCloseHandler() {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      const window = getCurrentWindow()
      const stop = await window.onCloseRequested((event) => {
        // WHY getState() at close time: the user may flip the setting while
        // the listener is live — a subscription-free read is always fresh.
        if (useDesktopSettingsStore.getState().closeToTray) {
          event.preventDefault()
          window.hide().catch((err: unknown) => {
            logger.warn('close_to_tray_hide_failed', {
              error: err instanceof Error ? err.message : String(err),
            })
          })
        }
        // WHY no else: when not prevented, Tauri's onCloseRequested wrapper
        // destroys the window — the standard quit path.
      })
      if (cancelled) {
        stop()
      } else {
        unlisten = stop
      }
    }

    setupCloseHandler().catch((err: unknown) => {
      logger.error('close_to_tray_setup_failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    })

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])
}
