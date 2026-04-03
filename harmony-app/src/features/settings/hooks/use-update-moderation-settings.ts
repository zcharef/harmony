import { useMutation, useQueryClient } from '@tanstack/react-query'
import i18n from 'i18next'
import type { UpdateModerationSettingsRequest } from '@/lib/api'
import { updateModerationSettings } from '@/lib/api'
import { getApiErrorDetail } from '@/lib/api-error'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'
import { toast } from '@/lib/toast'

export function useUpdateModerationSettings(serverId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (input: UpdateModerationSettingsRequest) => {
      const { data } = await updateModerationSettings({
        path: { id: serverId },
        body: input,
        throwOnError: true,
      })
      return data
    },
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.servers.moderation(serverId), data)
    },
    onError: (error) => {
      logger.error('update_moderation_settings_failed', {
        serverId,
        error: error instanceof Error ? error.message : String(error),
      })
      toast.error(getApiErrorDetail(error, i18n.t('settings:moderationUpdateFailed')))
    },
  })
}
