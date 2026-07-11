import { useMutation, useQueryClient } from '@tanstack/react-query'
import i18n from 'i18next'
import { deleteMessage, type ReportListResponse } from '@/lib/api'
import { getApiErrorDetail } from '@/lib/api-error'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'
import { toast } from '@/lib/toast'

interface DeleteReportedMessageInput {
  reportId: string
  channelId: string
  messageId: string
}

/**
 * Moderator row action: delete the reported message. The backend already writes
 * an audit-log row for the moderator delete, so the reports queue only needs to
 * optimistically drop the acted-on row (§5.2). The report itself stays open —
 * the moderator explicitly Resolves/Dismisses to close it, so a deleted message
 * with an unresolved report never silently disappears from the queue.
 */
export function useDeleteReportedMessage(serverId: string) {
  const queryClient = useQueryClient()
  const key = queryKeys.servers.reports(serverId)

  return useMutation({
    mutationFn: async ({ channelId, messageId }: DeleteReportedMessageInput) => {
      await deleteMessage({
        path: { channel_id: channelId, message_id: messageId },
        throwOnError: true,
      })
    },
    onSuccess: (_data, { reportId }) => {
      // Mark the message deleted in the cached row so the snippet greys out
      // (§UX: "[message deleted]") without a refetch.
      const previous = queryClient.getQueryData<ReportListResponse>(key)
      if (previous !== undefined) {
        queryClient.setQueryData<ReportListResponse>(key, {
          ...previous,
          items: previous.items.map((r) =>
            r.id === reportId
              ? { ...r, message: { ...r.message, deleted: true, snippet: undefined } }
              : r,
          ),
        })
      }
    },
    onError: (error) => {
      logger.error('delete_reported_message_failed', {
        serverId,
        error: error instanceof Error ? error.message : String(error),
      })
      toast.error(getApiErrorDetail(error, i18n.t('moderation:deleteMessageFailed')))
    },
  })
}
