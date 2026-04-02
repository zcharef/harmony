import { useMutation, useQueryClient } from '@tanstack/react-query'
import i18n from 'i18next'
import type { UpdateServerRequest } from '@/lib/api'
import { updateServer } from '@/lib/api'
import { getApiErrorDetail } from '@/lib/api-error'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'
import { toast } from '@/lib/toast'

export function useUpdateServer(serverId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (input: UpdateServerRequest) => {
      const { data } = await updateServer({
        path: { id: serverId },
        body: input,
        throwOnError: true,
      })
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.servers.all })
      queryClient.invalidateQueries({ queryKey: queryKeys.servers.detail(serverId) })
    },
    onError: (error) => {
      logger.error('update_server_failed', {
        serverId,
        error: error instanceof Error ? error.message : String(error),
      })
      toast.error(getApiErrorDetail(error, i18n.t('servers:updateServerFailed')))
    },
  })
}
