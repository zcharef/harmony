import { useMutation, useQueryClient } from '@tanstack/react-query'
import i18n from 'i18next'
import { client } from '@/lib/api/client.gen'
import { getApiErrorDetail } from '@/lib/api-error'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'
import { toast } from '@/lib/toast'

/**
 * WHY: DELETE /v1/servers/{server_id}/members/{user_id} is not yet in the
 * generated SDK. Uses the raw hey-api client directly.
 */
export function useKickMember(serverId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (userId: string) => {
      const { error } = await client.delete({
        url: '/v1/servers/{server_id}/members/{user_id}',
        path: { server_id: serverId, user_id: userId },
        security: [{ scheme: 'bearer', type: 'http' }],
      })
      if (error) throw error
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.servers.members(serverId) })
    },
    onError: (error) => {
      logger.error('Failed to kick member', {
        serverId,
        error: error instanceof Error ? error.message : String(error),
      })
      toast.error(getApiErrorDetail(error, i18n.t('members:kickFailed')))
    },
  })
}
