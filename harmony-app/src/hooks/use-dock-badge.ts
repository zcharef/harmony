import { useEffect } from 'react'
import { useTotalUnread } from '@/features/channels'
import { logger } from '@/lib/logger'
import { isTauri } from '@/lib/platform'

/**
 * Sets the macOS dock icon badge count to the total unread count.
 *
 * WHY: Desktop users need an at-a-glance indicator on the dock/taskbar icon.
 * Uses Tauri's built-in setBadgeCount() which maps to NSDockTile on macOS.
 * On Windows this is a no-op (Tauri handles gracefully). On Linux, behavior
 * depends on the desktop environment.
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
        // WHY: undefined clears the badge on macOS. setBadgeCount is a
        // silent no-op on Windows (Tauri returns Ok(())).
        await getCurrentWindow().setBadgeCount(totalUnread > 0 ? totalUnread : undefined)
      } catch (err: unknown) {
        // WHY: Background operation — fail silently (ADR-045).
        logger.warn('dock_badge_update_failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    updateBadge()
  }, [totalUnread])
}
