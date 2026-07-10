import { useQuery } from '@tanstack/react-query'
import { listNotificationSettings, type NotificationLevel } from '@/lib/api'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'

export type NotificationSettingsMap = Record<string, NotificationLevel>

/**
 * Bulk per-channel notification overrides, fetched once and folded into a
 * channelId → level map (D9).
 *
 * WHY bulk: per-channel reads only ever covered the SELECTED channel — a
 * channel muted to 'none' still notified until visited. The policy reads this
 * map for every incoming event; `undefined` entry = no override = 'all'.
 *
 * WHY explicit freshness options: `refetchOnWindowFocus` is globally disabled
 * (App.tsx) and JWT-rotation reconnects skip invalidation — without these a
 * mute made on device B would never reach a healthy device A. Guarantee: a
 * change lands at the next window focus (or genuine SSE reconnect).
 */
export function useNotificationSettingsMap() {
  return useQuery({
    queryKey: queryKeys.notificationSettings.mine(),
    queryFn: async () => {
      try {
        const { data } = await listNotificationSettings({ throwOnError: true })
        return data
      } catch (err: unknown) {
        // WHY warn + rethrow: background read — no user-facing error (the map
        // stays undefined → fail-open to 'all'), but the failure must be
        // observable (ADR-027).
        logger.warn('notification_settings_bulk_fetch_failed', {
          error: err instanceof Error ? err.message : String(err),
        })
        throw err
      }
    },
    select: (data): NotificationSettingsMap => {
      const map: NotificationSettingsMap = {}
      for (const item of data.items) {
        map[item.channelId] = item.level
      }
      return map
    },
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  })
}
