import { useMutation } from '@tanstack/react-query'
import { type ReportReason, reportMessage } from '@/lib/api'
import { logger } from '@/lib/logger'

interface ReportMessageInput {
  channelId: string
  messageId: string
  reason: ReportReason
  detail?: string
}

/**
 * File a report against a message. Explicit user action → the dialog surfaces
 * the error inline (409 already-reported, 429 rate-limited, etc.) by reading
 * `mutation.error`; this hook only logs a breadcrumb (ADR-028).
 */
export function useReportMessage() {
  return useMutation({
    mutationFn: async ({ channelId, messageId, reason, detail }: ReportMessageInput) => {
      const { data } = await reportMessage({
        path: { channel_id: channelId, message_id: messageId },
        body: { reason, detail },
        throwOnError: true,
      })
      return data
    },
    onError: (error) => {
      logger.error('report_message_failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    },
  })
}
