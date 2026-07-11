import { useMutation, useQueryClient } from '@tanstack/react-query'
import i18n from 'i18next'
import { blockUser } from '@/lib/api'
import { getApiErrorDetail } from '@/lib/api-error'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'
import { toast } from '@/lib/toast'

/**
 * Block a user (idempotent PUT). Blocking tears down any friendship/pending
 * request between the pair and gates new DMs, so all four caches are refreshed.
 */
export function useBlockUser() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (userId: string) => {
      await blockUser({ path: { user_id: userId }, throwOnError: true })
      return userId
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.friends.list() })
      queryClient.invalidateQueries({ queryKey: queryKeys.friends.requests('incoming') })
      queryClient.invalidateQueries({ queryKey: queryKeys.friends.requests('outgoing') })
      queryClient.invalidateQueries({ queryKey: queryKeys.friends.blocks() })
      queryClient.invalidateQueries({ queryKey: queryKeys.dms.all })
    },
    onError: (error) => {
      logger.error('block_user_failed', {
        error: error instanceof Error ? error.message : String(error),
      })
      toast.error(getApiErrorDetail(error, i18n.t('friends:blockFailed')))
    },
  })
}
