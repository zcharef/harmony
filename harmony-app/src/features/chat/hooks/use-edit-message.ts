import { useMutation, useQueryClient } from '@tanstack/react-query'
import i18n from 'i18next'
import { editMessage } from '@/lib/api'
import { getApiErrorDetail } from '@/lib/api-error'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'
import { toast } from '@/lib/toast'

/**
 * WHY invalidation (not optimistic update): Edit is a low-frequency action
 * where a ~200ms delay is acceptable. Optimistic updates would require
 * snapshot/rollback logic for minimal UX gain. Invalidation keeps it simple.
 */
export function useEditMessage(channelId: string) {
  const queryClient = useQueryClient()
  const messageQueryKey = queryKeys.messages.byChannel(channelId)

  return useMutation({
    mutationFn: async ({ messageId, content }: { messageId: string; content: string }) => {
      const { data } = await editMessage({
        path: { channel_id: channelId, message_id: messageId },
        body: { content },
        throwOnError: true,
      })
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: messageQueryKey })
    },
    onError: (error) => {
      logger.error('Failed to edit message', {
        channelId,
        error: error instanceof Error ? error.message : String(error),
      })
      toast.error(getApiErrorDetail(error, i18n.t('chat:editMessageFailed')))
    },
  })
}
