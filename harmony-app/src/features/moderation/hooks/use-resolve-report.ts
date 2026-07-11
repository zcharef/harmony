import { useMutation, useQueryClient } from '@tanstack/react-query'
import i18n from 'i18next'
import { type ReportListResponse, type ReportStatus, resolveReport } from '@/lib/api'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'
import { toastApiError } from '@/lib/toast'

interface ResolveReportInput {
  reportId: string
  status: Extract<ReportStatus, 'resolved' | 'dismissed'>
}

/**
 * Resolve or dismiss a report (moderator+). Optimistically drops the row from
 * the open queue and decrements the badge; reverts on error (ADR-028: explicit
 * user action gets visible feedback).
 */
export function useResolveReport(serverId: string) {
  const queryClient = useQueryClient()
  const key = queryKeys.servers.reports(serverId)

  return useMutation({
    mutationFn: async ({ reportId, status }: ResolveReportInput) => {
      const { data } = await resolveReport({
        path: { id: serverId, report_id: reportId },
        body: { status },
        throwOnError: true,
      })
      return data
    },
    onMutate: async ({ reportId }) => {
      await queryClient.cancelQueries({ queryKey: key })
      const previous = queryClient.getQueryData<ReportListResponse>(key)
      if (previous !== undefined) {
        queryClient.setQueryData<ReportListResponse>(key, {
          ...previous,
          items: previous.items.filter((r) => r.id !== reportId),
          openCount: Math.max(0, previous.openCount - 1),
        })
      }
      return { previous }
    },
    onError: (error, _input, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(key, context.previous)
      }
      logger.error('resolve_report_failed', {
        serverId,
        error: error instanceof Error ? error.message : String(error),
      })
      toastApiError(error, i18n.t('moderation:resolveFailed'))
    },
  })
}
