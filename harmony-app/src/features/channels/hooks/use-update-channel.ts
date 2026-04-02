import { useMutation, useQueryClient } from '@tanstack/react-query'
import i18n from 'i18next'
import type { UpdateChannelRequest } from '@/lib/api'
import { updateChannel } from '@/lib/api'
import { getApiErrorDetail } from '@/lib/api-error'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'
import { toast } from '@/lib/toast'

/**
 * WHY: Wraps updateChannel SDK in a mutation with automatic cache
 * invalidation so the channel list refreshes after edits.
 */
export function useUpdateChannel(serverId: string, channelId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (input: UpdateChannelRequest) => {
      const { data } = await updateChannel({
        path: { id: serverId, channel_id: channelId },
        body: input,
        throwOnError: true,
      })
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.channels.byServer(serverId) })
    },
    onError: (error) => {
      logger.error('update_channel_failed', {
        error: error instanceof Error ? error.message : String(error),
      })
      toast.error(getApiErrorDetail(error, i18n.t('channels:updateChannelFailed')))
    },
  })
}
