import { useMutation, useQueryClient } from '@tanstack/react-query'
import i18n from 'i18next'
import { unblockUser } from '@/lib/api'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'
import { toastApiError } from '@/lib/toast'

/** Unblock a user (idempotent). Does NOT restore any prior friendship. */
export function useUnblockUser() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (userId: string) => {
      await unblockUser({ path: { user_id: userId }, throwOnError: true })
      return userId
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.friends.blocks() })
    },
    onError: (error) => {
      logger.error('unblock_user_failed', {
        error: error instanceof Error ? error.message : String(error),
      })
      toastApiError(error, i18n.t('friends:unblockFailed'))
    },
  })
}
