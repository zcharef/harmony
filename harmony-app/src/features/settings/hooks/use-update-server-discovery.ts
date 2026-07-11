import { useMutation, useQueryClient } from '@tanstack/react-query'
import i18n from 'i18next'
import type { UpdateServerDiscoveryRequest } from '@/lib/api'
import { updateServerDiscovery } from '@/lib/api'
import { getApiErrorDetail } from '@/lib/api-error'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'
import { toast } from '@/lib/toast'

export function useUpdateServerDiscovery(serverId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (input: UpdateServerDiscoveryRequest) => {
      const { data } = await updateServerDiscovery({
        path: { id: serverId },
        body: input,
        throwOnError: true,
      })
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.servers.all })
      // WHY: a changed listing state must not serve a stale directory page.
      queryClient.invalidateQueries({ queryKey: queryKeys.discovery.all })
      toast.success(i18n.t('settings:discoverySaved'))
    },
    onError: (error) => {
      logger.error('update_server_discovery_failed', {
        serverId,
        error: error instanceof Error ? error.message : String(error),
      })
      toast.error(getApiErrorDetail(error, i18n.t('settings:discoverySaveFailed')))
    },
  })
}
