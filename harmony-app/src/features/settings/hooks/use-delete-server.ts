import { useMutation, useQueryClient } from '@tanstack/react-query'
import i18n from 'i18next'
import { client } from '@/lib/api/client.gen'
import { getApiErrorDetail } from '@/lib/api-error'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'
import { toast } from '@/lib/toast'

/**
 * WHY: DELETE /v1/servers/{id} is not yet in the generated SDK.
 * Uses the raw hey-api client directly until `just gen-api` regenerates.
 */
export function useDeleteServer() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (serverId: string) => {
      const { error } = await client.delete({
        url: '/v1/servers/{id}',
        path: { id: serverId },
        security: [{ scheme: 'bearer', type: 'http' }],
      })
      if (error) throw error
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.servers.all })
    },
    onError: (error) => {
      logger.error('Failed to delete server', {
        error: error instanceof Error ? error.message : String(error),
      })
      toast.error(getApiErrorDetail(error, i18n.t('servers:deleteServerFailed')))
    },
  })
}
