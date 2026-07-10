import { useMutation, useQueryClient } from '@tanstack/react-query'
import i18n from 'i18next'
import type { ListNotificationSettingsResponse, NotificationLevel } from '@/lib/api'
import { updateNotificationSettings } from '@/lib/api'
import { getApiErrorDetail } from '@/lib/api-error'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'
import { toast } from '@/lib/toast'

/**
 * WHY optimistic into the bulk map cache (not a per-channel key): the mine()
 * bulk query is the single source of truth for every override (D9) — the bell
 * popover AND the notification policy read it, so the change takes effect on
 * the very next incoming event, no refetch.
 */
export function useUpdateNotificationSettings(channelId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (level: NotificationLevel) => {
      await updateNotificationSettings({
        path: { id: channelId },
        body: { level },
        throwOnError: true,
      })
    },
    onMutate: async (level) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.notificationSettings.mine() })

      const previousData = queryClient.getQueryData<ListNotificationSettingsResponse>(
        queryKeys.notificationSettings.mine(),
      )

      queryClient.setQueryData<ListNotificationSettingsResponse>(
        queryKeys.notificationSettings.mine(),
        (old) => {
          const items = (old?.items ?? []).filter((item) => item.channelId !== channelId)
          // WHY unshift: the server orders by updated_at DESC — the row just
          // touched belongs first.
          const nextItems = [{ channelId, level }, ...items]
          return {
            items: nextItems,
            total: nextItems.length,
            nextCursor: old?.nextCursor ?? null,
          }
        },
      )

      return { previousData }
    },
    onError: (error, _level, context) => {
      queryClient.setQueryData(
        queryKeys.notificationSettings.mine(),
        context?.previousData ?? { items: [], total: 0, nextCursor: null },
      )

      logger.error('update_notification_settings_failed', {
        channelId,
        error: error instanceof Error ? error.message : String(error),
      })
      toast.error(getApiErrorDetail(error, i18n.t('chat:updateNotificationsFailed')))
    },
  })
}
