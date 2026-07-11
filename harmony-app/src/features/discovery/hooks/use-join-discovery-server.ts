import { useMutation, useQueryClient } from '@tanstack/react-query'
import i18n from 'i18next'
import { joinDiscoveryServer } from '@/lib/api'
import { getApiErrorDetail } from '@/lib/api-error'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'
import { toast } from '@/lib/toast'

/**
 * One-click direct join from the directory. The API re-checks that the
 * server is still discoverable and that the caller is not banned; an
 * existing membership is an idempotent no-op (the caller just navigates).
 */
export function useJoinDiscoveryServer() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (serverId: string) => {
      await joinDiscoveryServer({ path: { id: serverId }, throwOnError: true })
      return serverId
    },
    onSuccess: () => {
      // WHY invalidate (not patch): the joined server enters the rail list
      // with fields the directory card does not carry (ownerId, timestamps).
      queryClient.invalidateQueries({ queryKey: queryKeys.servers.all })
    },
    onError: (error, serverId) => {
      logger.error('discovery_join_failed', {
        serverId,
        error: error instanceof Error ? error.message : String(error),
      })
      toast.error(getApiErrorDetail(error, i18n.t('discovery:joinFailed')))
    },
  })
}
