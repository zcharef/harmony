import { Avatar, Button, Chip, Spinner } from '@heroui/react'
import { AlertTriangle, ScrollText, ShieldAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { type MemberRole, ROLE_HIERARCHY } from '@/features/members'
import type { ModerationAction, ModerationLogResponse } from '@/lib/api'
import { useModerationLog } from './hooks/use-moderation-log'

interface AuditLogTabProps {
  serverId: string
  callerRole: MemberRole
}

type ChipColor = 'danger' | 'warning' | 'secondary' | 'success' | 'default'

// WHY color-per-action: the action is the focal element of each row; color is a
// secondary cue (an aria-label carries the meaning — color is never the only signal).
const ACTION_CHIP: Record<ModerationAction, ChipColor> = {
  member_ban: 'danger',
  member_kick: 'warning',
  member_unban: 'success',
  member_timeout: 'secondary',
  member_timeout_remove: 'success',
  message_delete: 'default',
  message_bulk_delete: 'default',
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

export function AuditLogTab({ serverId, callerRole }: AuditLogTabProps) {
  const { t } = useTranslation('moderation')
  const isAdmin = ROLE_HIERARCHY[callerRole] >= ROLE_HIERARCHY.admin
  const { data, isPending, isError, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useModerationLog(serverId)

  if (isAdmin === false) {
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
        data-test="settings-audit-error"
        className="flex flex-col items-center justify-center gap-2 py-12"
      >
        <AlertTriangle className="h-10 w-10 text-danger-300" />
        <p className="text-sm text-default-500">{t('auditLoadError')}</p>
      </div>
    )
  }

  const entries = data.pages.flatMap((page) => page.items)

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-foreground">{t('auditTitle')}</h2>
        <p className="mt-1 text-sm text-default-500">{t('auditDescription')}</p>
      </div>

      {entries.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-12">
          <ScrollText className="h-10 w-10 text-default-300" />
          <p className="text-sm text-default-500">{t('auditEmpty')}</p>
        </div>
      ) : (
        <div data-test="settings-audit-list" className="space-y-1">
          {entries.map((entry) => (
            <AuditRow key={entry.id} entry={entry} />
          ))}
        </div>
      )}

      {hasNextPage === true && (
        <div className="flex justify-center">
          <Button
            size="sm"
            variant="flat"
            onPress={() => fetchNextPage()}
            isLoading={isFetchingNextPage}
            data-test="audit-load-more"
          >
            {t('loadMore')}
          </Button>
        </div>
      )}
    </div>
  )
}

function AuditRow({ entry }: { entry: ModerationLogResponse }) {
  const { t } = useTranslation('moderation')
  const relative = relativeTime(entry.createdAt)
  const actionLabel = t(`action.${entry.action}`)
  const actorName = entry.actorUsername.length > 0 ? entry.actorUsername : t('unknownActor')

  return (
    <div
      className="flex items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-default-50"
      data-test="audit-row"
    >
      <Avatar
        name={actorName}
        src={entry.actorAvatarUrl ?? undefined}
        size="sm"
        showFallback
        classNames={{ base: 'h-8 w-8 shrink-0', name: 'text-xs' }}
      />
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{actorName}</span>
          <Chip
            size="sm"
            variant="flat"
            color={ACTION_CHIP[entry.action]}
            aria-label={actionLabel}
            data-test="audit-action-chip"
          >
            {actionLabel}
          </Chip>
          {entry.targetUsername !== undefined && entry.targetUsername !== null && (
            <span className="truncate text-sm text-default-500">{entry.targetUsername}</span>
          )}
        </div>
        {entry.reason !== undefined && entry.reason !== null && entry.reason.length > 0 && (
          <span className="truncate text-xs text-default-400">{entry.reason}</span>
        )}
      </div>
      <time className="shrink-0 text-xs text-default-400" dateTime={entry.createdAt}>
        {relative}
      </time>
    </div>
  )
}
