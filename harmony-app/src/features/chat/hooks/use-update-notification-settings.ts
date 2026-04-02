import { useMutation, useQueryClient } from '@tanstack/react-query'
import i18n from 'i18next'
import type { NotificationLevel } from '@/lib/api'
import { updateNotificationSettings } from '@/lib/api'
import { getApiErrorDetail } from '@/lib/api-error'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'
import { toast } from '@/lib/toast'

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
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.notificationSettings.byChannel(channelId),
      })
    },
    onError: (error) => {
      logger.error('update_notification_settings_failed', {
        channelId,
        error: error instanceof Error ? error.message : String(error),
      })
      toast.error(getApiErrorDetail(error, i18n.t('chat:updateNotificationsFailed')))
    },
  })
}
