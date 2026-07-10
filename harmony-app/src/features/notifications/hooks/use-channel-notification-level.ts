import type { NotificationLevel } from '@/lib/api'
import { useNotificationSettingsMap } from './use-notification-settings-map'

/**
 * Notification level for ONE channel, selected from the bulk map cache —
 * single source of truth for the bell popover (replaces the per-channel GET).
 * Defaults to 'all' when no override exists.
 */
export function useChannelNotificationLevel(channelId: string | null): NotificationLevel {
  const { data } = useNotificationSettingsMap()
  if (channelId === null) return 'all'
  return data?.[channelId] ?? 'all'
}
