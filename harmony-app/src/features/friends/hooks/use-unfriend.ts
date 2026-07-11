import { useMutation, useQueryClient } from '@tanstack/react-query'
import i18n from 'i18next'
import { unfriend } from '@/lib/api'
import { getApiErrorDetail } from '@/lib/api-error'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'
import { toast } from '@/lib/toast'

/**
 * Remove a friend (idempotent). The realtime removal is driven by the
 * `friend.removed` SSE handler; this settles the friends cache.
 */
export function useUnfriend() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (userId: string) => {
      await unfriend({ path: { user_id: userId }, throwOnError: true })
      return userId
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.friends.list() })
    },
    onError: (error) => {
      logger.error('unfriend_failed', {
        error: error instanceof Error ? error.message : String(error),
      })
      toast.error(getApiErrorDetail(error, i18n.t('friends:unfriendFailed')))
    },
  })
}
