import { Button, Chip, Spinner } from '@heroui/react'
import { AlertTriangle, ShieldAlert, ShieldCheck, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { type MemberRole, ROLE_HIERARCHY } from '@/features/members'
import type { ReportResponse } from '@/lib/api'
import { useDeleteReportedMessage } from './hooks/use-delete-reported-message'
import { useReports } from './hooks/use-reports'
import { useResolveReport } from './hooks/use-resolve-report'

interface ReportsTabProps {
  serverId: string
  callerRole: MemberRole
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
function relativeTime(iso: string): string {
  const diffSec = (new Date(iso).getTime() - Date.now()) / 1000
  const abs = Math.abs(diffSec)
  if (abs < 60) return rtf.format(Math.round(diffSec), 'second')
  if (abs < 3600) return rtf.format(Math.round(diffSec / 60), 'minute')
  if (abs < 86_400) return rtf.format(Math.round(diffSec / 3600), 'hour')
  return rtf.format(Math.round(diffSec / 86_400), 'day')
}

const KNOWN_REASONS = new Set(['spam', 'harassment', 'nsfw', 'violence'])

export function ReportsTab({ serverId, callerRole }: ReportsTabProps) {
  const { t } = useTranslation('moderation')
  const isModerator = ROLE_HIERARCHY[callerRole] >= ROLE_HIERARCHY.moderator
  const { data, isPending, isError } = useReports(serverId, isModerator)

  if (isModerator === false) {
    return (
      <div
        data-test="settings-insufficient-permissions"
        className="flex flex-col items-center justify-center gap-2 py-12"
      >
        <ShieldAlert className="h-10 w-10 text-default-300" />
        <p className="text-sm text-default-500">{t('insufficientPermissions')}</p>
      </div>
    )
  }

  if (isPending) {
    return (
      <div className="flex justify-center py-8">
        <Spinner size="md" />
      </div>
    )
  }

  if (isError) {
    return (
      <div
        data-test="settings-reports-error"
        className="flex flex-col items-center justify-center gap-2 py-12"
      >
        <AlertTriangle className="h-10 w-10 text-danger-300" />
        <p className="text-sm text-default-500">{t('reportsLoadError')}</p>
      </div>
    )
  }

  const reports = data.items

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-foreground">{t('reportsTitle')}</h2>
        <p className="mt-1 text-sm text-default-500">{t('reportsDescription')}</p>
      </div>

      {reports.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-12">
          <ShieldCheck className="h-10 w-10 text-default-300" />
          <p className="text-sm text-default-500">{t('reportsEmpty')}</p>
        </div>
      ) : (
        <div data-test="settings-reports-list" className="space-y-3">
          {reports.map((report) => (
            <ReportCard key={report.id} serverId={serverId} report={report} />
          ))}
        </div>
      )}
    </div>
  )
}

interface ReportCardProps {
  serverId: string
  report: ReportResponse
}

function ReportCard({ serverId, report }: ReportCardProps) {
  const { t } = useTranslation('moderation')
  const resolve = useResolveReport(serverId)
  const deleteMsg = useDeleteReportedMessage(serverId)
  const busy = resolve.isPending || deleteMsg.isPending

  const reasonLabel = KNOWN_REASONS.has(report.reason)
    ? t(`reason.${report.reason}`)
    : report.reason

  return (
    <div
      className="rounded-lg border border-divider bg-content1 p-4"
      data-test="report-row"
      data-report-id={report.id}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-1 flex-col gap-1.5 overflow-hidden">
          <div className="flex items-center gap-2">
            <Chip size="sm" variant="flat" color="warning" aria-label={reasonLabel}>
              {reasonLabel}
            </Chip>
            <span className="truncate text-xs text-default-400">
              {t('reportedBy', { username: report.reporterUsername })}
            </span>
            <time className="shrink-0 text-xs text-default-400" dateTime={report.createdAt}>
              {relativeTime(report.createdAt)}
            </time>
          </div>

          <MessageSnippet report={report} />

          <span className="text-xs text-default-400">
            {t('reportedAuthor', { username: report.reportedUsername })}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {busy && <Spinner size="sm" data-test="report-row-spinner" />}
          <Button
            size="sm"
            variant="flat"
            color="danger"
            startContent={<Trash2 className="h-3.5 w-3.5" />}
            isDisabled={busy || report.message.deleted}
            onPress={() => {
              // Destructive + irreversible → confirm first, matching the
              // codebase pattern (channel-sidebar / channels-tab).
              if (!window.confirm(t('deleteMessageConfirm'))) return
              deleteMsg.mutate({
                reportId: report.id,
                channelId: report.channelId,
                messageId: report.messageId,
              })
            }}
            data-test="report-delete-message"
          >
            {t('deleteMessage')}
          </Button>
          <Button
            size="sm"
            variant="flat"
            color="success"
            isDisabled={busy}
            onPress={() => resolve.mutate({ reportId: report.id, status: 'resolved' })}
            data-test="report-resolve"
          >
            {t('resolve')}
          </Button>
          <Button
            size="sm"
            variant="light"
            isDisabled={busy}
            onPress={() => resolve.mutate({ reportId: report.id, status: 'dismissed' })}
            data-test="report-dismiss"
          >
            {t('dismiss')}
          </Button>
        </div>
      </div>

      {(resolve.isError || deleteMsg.isError) && (
        <p className="mt-2 text-xs text-danger" data-test="report-row-error">
          {t('actionFailed')}
        </p>
      )}
    </div>
  )
}

function MessageSnippet({ report }: { report: ReportResponse }) {
  const { t } = useTranslation('moderation')
  if (report.message.deleted) {
    return <span className="text-sm italic text-default-400">{t('messageDeleted')}</span>
  }
  if (report.message.encrypted) {
    return <span className="text-sm italic text-default-400">{t('messageEncrypted')}</span>
  }
  return <p className="line-clamp-2 text-sm text-foreground">{report.message.snippet ?? ''}</p>
}
