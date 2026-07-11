import { useEffect } from 'react'
import { useTotalUnread } from '@/features/channels'
import { logger } from '@/lib/logger'
import { renderOverlayBadgePng } from '@/lib/overlay-badge'
import { isTauri, isWindows } from '@/lib/platform'

/**
 * Sets the dock/taskbar unread indicator to the total unread count.
 *
 * WHY two per-OS paths (explicit, never fall through):
 * - macOS/Linux: Tauri's setBadgeCount() maps to NSDockTile on macOS; on
 *   Linux behavior depends on the desktop environment.
 * - Windows: setBadgeCount() is unsupported — the taskbar equivalent is
 *   setOverlayIcon() with a small canvas-generated count badge, cleared
 *   with `undefined` when unread drops to 0.
 *
 * Follows the same isTauri() guard + dynamic import pattern as use-app-updater.ts.
 */
export function useDockBadge(): void {
  const totalUnread = useTotalUnread()

  useEffect(() => {
    if (!isTauri()) return

    async function updateBadge() {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')

        if (isWindows()) {
          // WHY <= 0: a desynced unread store must clear the badge, never
          // render a negative count.
          if (totalUnread <= 0) {
            // WHY undefined: clears the overlay icon per the Tauri API contract.
            await getCurrentWindow().setOverlayIcon(undefined)
            return
          }
          const png = renderOverlayBadgePng(totalUnread)
          // WHY null check: canvas failure is already logged in the renderer;
          // keep the previous overlay rather than clearing a valid indicator.
          if (png === null) return
          await getCurrentWindow().setOverlayIcon(png)
          return
        }

        // WHY: undefined clears the badge on macOS.
        await getCurrentWindow().setBadgeCount(totalUnread > 0 ? totalUnread : undefined)
      } catch (err: unknown) {
        // WHY: Background operation — fail silently (ADR-045).
        logger.warn('dock_badge_update_failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    void updateBadge()
  }, [totalUnread])
}
