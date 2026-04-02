import { useMutation, useQueryClient } from '@tanstack/react-query'
import i18n from 'i18next'
import type { UserId } from '@/lib/api'
import { createDm } from '@/lib/api'
import { getApiErrorDetail } from '@/lib/api-error'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'
import { toast } from '@/lib/toast'

/**
 * WHY: Wraps createDm SDK in a mutation with automatic cache invalidation
 * so the DM list refreshes after creation. Also invalidates the server list
 * because DMs are servers with isDm=true.
 *
 * WHY no requestReconnect: The backend SSE handler (events.rs) now dynamically
 * updates the server_ids filter via a tokio::sync::watch channel. The DmCreated
 * event intercept matches both sender_id (creator) and target_user_id (recipient),
 * adding the DM server_id to both users' filter sets. No client-side reconnect needed.
 */
export function useCreateDm() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (recipientId: UserId) => {
      const { data } = await createDm({
        body: { recipientId },
        throwOnError: true,
      })
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.dms.all })
      queryClient.invalidateQueries({ queryKey: queryKeys.servers.all })
    },
    onError: (error) => {
      logger.error('Failed to create DM', {
        error: error instanceof Error ? error.message : String(error),
      })
      toast.error(getApiErrorDetail(error, i18n.t('dms:createDmFailed')))
    },
  })
}
