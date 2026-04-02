import { useMutation, useQueryClient } from '@tanstack/react-query'
import i18n from 'i18next'
import { deleteChannel } from '@/lib/api'
import { getApiErrorDetail } from '@/lib/api-error'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'
import { toast } from '@/lib/toast'

/**
 * WHY: Wraps deleteChannel SDK in a mutation with automatic cache
 * invalidation so the channel list refreshes after deletion.
 */
export function useDeleteChannel(serverId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (channelId: string) => {
      await deleteChannel({
        path: { id: serverId, channel_id: channelId },
        throwOnError: true,
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.channels.byServer(serverId) })
    },
    onError: (error) => {
      logger.error('delete_channel_failed', {
        error: error instanceof Error ? error.message : String(error),
      })
      toast.error(getApiErrorDetail(error, i18n.t('channels:deleteChannelFailed')))
    },
  })
}
