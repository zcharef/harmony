import { Avatar, Progress, Spinner } from '@heroui/react'
import { Rocket, Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ErrorState } from '@/components/shared/error-state'
import type {
  AliveSnapshotResponse,
  FollowThroughResponse,
  MigrationProgressResponse,
  NotYetActiveMemberResponse,
  RecommendedActionResponse,
} from '@/lib/api'
import { resolveDisplayName } from '@/lib/display-name'
import { useMigrationCohort } from './hooks/use-migration-cohort'
import { useMigrationProgress } from './hooks/use-migration-progress'

interface MigrationCenterProps {
  serverId: string | null
}

/**
 * Owner-facing member-migration command center (growth-plan §14.1).
 *
 * Surfaces the honest "alive server" progress, all-time follow-through counts,
 * the single recommended next step, and the not-yet-active member cohort so the
 * owner can see the follow-through gap and act on it. Every number traces to
 * the §5/§10 analytics views via the Rust API.
 */
export function MigrationCenter({ serverId }: MigrationCenterProps) {
  const { t } = useTranslation('migration')
  const progress = useMigrationProgress(serverId)
  const cohort = useMigrationCohort(serverId)

  if (progress.isPending) {
    return (
      <div
        data-test="migration-loading"
        className="flex h-full items-center justify-center bg-background"
      >
        <Spinner size="sm" label={t('loading')} />
      </div>
    )
  }

  if (progress.isError) {
    return (
      <div className="flex h-full items-center justify-center bg-background">
        <ErrorState
          icon={<Rocket className="h-10 w-10" />}
          message={t('failedToLoad')}
          onRetry={() => progress.refetch()}
          isRetrying={progress.isRefetching}
        />
      </div>
    )
  }

  const data: MigrationProgressResponse = progress.data

  return (
    <div data-test="migration-center" className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-foreground">{t('title')}</h1>
        <p className="text-sm text-default-500">{t('subtitle')}</p>
      </header>

      <ActionBanner action={data.recommendedAction} />
      <AliveCard alive={data.alive} />
      <FollowThroughRow followThrough={data.followThrough} />
      <CohortSection
        items={cohort.data?.items ?? []}
        total={cohort.data?.total ?? 0}
        isPending={cohort.isPending}
        isError={cohort.isError}
        onRetry={() => cohort.refetch()}
        isRetrying={cohort.isRefetching}
      />

      <p className="text-xs text-default-400">{t('honestyNote')}</p>
    </div>
  )
}

function ActionBanner({ action }: { action: RecommendedActionResponse }) {
  const { t } = useTranslation('migration')
  return (
    <section
      data-test="migration-action"
      data-action={action}
      className="rounded-large border border-primary-200 bg-primary-50 p-4"
    >
      <div className="mb-1 flex items-center gap-2">
        <Rocket className="h-4 w-4 text-primary" />
        <span className="text-xs font-semibold uppercase tracking-wide text-primary">
          {t('actionTitle')}
        </span>
      </div>
      <h2 className="text-base font-semibold text-foreground">{t(`action_${action}_title`)}</h2>
      <p className="mt-1 text-sm text-default-600">{t(`action_${action}_body`)}</p>
    </section>
  )
}

function AliveCard({ alive }: { alive: AliveSnapshotResponse }) {
  const { t } = useTranslation('migration')

  const status = alive.isAlive === true ? 'alive' : alive.isAlive === false ? 'notAlive' : 'pending'
  const statusLabel = {
    alive: t('statusAlive'),
    notAlive: t('statusNotAlive'),
    pending: t('statusPending'),
  }[status]
  const statusHelp = {
    alive: t('statusAliveHelp'),
    notAlive: t('statusNotAliveHelp'),
    pending: t('statusPendingHelp'),
  }[status]
  const statusClass = {
    alive: 'bg-success-100 text-success-700',
    notAlive: 'bg-warning-100 text-warning-700',
    pending: 'bg-default-100 text-default-600',
  }[status]

  const criteria = [
    {
      key: 'membersJoined',
      label: t('criterionMembersJoined'),
      current: alive.membersJoinedWeek1,
      target: alive.thresholds.membersJoined,
    },
    {
      key: 'activeMembers',
      label: t('criterionActiveMembers'),
      current: alive.nonOwnerActiveWeek1,
      target: alive.thresholds.nonOwnerActive,
    },
    {
      key: 'messages',
      label: t('criterionMessages'),
      current: alive.messagesWeek1,
      target: alive.thresholds.messages,
    },
    {
      key: 'distinctSenders',
      label: t('criterionDistinctSenders'),
      current: alive.distinctSendersWeek1,
      target: alive.thresholds.distinctSenders,
    },
    {
      key: 'activeDays',
      label: t('criterionActiveDays'),
      current: alive.activeDaysWeek1,
      target: alive.thresholds.activeDays,
    },
  ]

  return (
    <section data-test="migration-alive" className="rounded-large border border-divider p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-foreground">{t('aliveTitle')}</h2>
        <span
          data-test="migration-alive-status"
          className={`rounded-full px-2 py-0.5 text-xs font-semibold ${statusClass}`}
        >
          {statusLabel}
        </span>
      </div>
      <p className="mb-4 text-sm text-default-500">{statusHelp}</p>
      <ul className="flex flex-col gap-3">
        {criteria.map((c) => {
          const met = c.current >= c.target
          return (
            <li key={c.key} data-test={`criterion-${c.key}`} className="flex flex-col gap-1">
              <Progress
                aria-label={c.label}
                size="sm"
                color={met ? 'success' : 'primary'}
                value={c.current}
                maxValue={c.target}
                label={c.label}
                valueLabel={t('criterionProgress', { current: c.current, target: c.target })}
                showValueLabel
                classNames={{ label: 'text-sm text-foreground', value: 'text-sm' }}
              />
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function FollowThroughRow({ followThrough }: { followThrough: FollowThroughResponse }) {
  const { t } = useTranslation('migration')
  const stats = [
    { key: 'joined', label: t('statJoined'), value: followThrough.membersJoined },
    { key: 'active', label: t('statActive'), value: followThrough.membersActive },
    { key: 'sentMessage', label: t('statSentMessage'), value: followThrough.membersSentMessage },
    { key: 'notYetActive', label: t('statNotYetActive'), value: followThrough.notYetActive },
  ]
  return (
    <section data-test="migration-follow-through" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {stats.map((s) => (
        <div
          key={s.key}
          data-test={`stat-${s.key}`}
          className="flex flex-col gap-1 rounded-large border border-divider p-3"
        >
          <span className="text-2xl font-semibold text-foreground">{s.value}</span>
          <span className="text-xs text-default-500">{s.label}</span>
        </div>
      ))}
    </section>
  )
}

type CohortStatus = 'loading' | 'error' | 'empty' | 'populated'

// WHY a status discriminant with early returns (not a nested ternary or a
// negation-combined boolean): the arch wall forbids complex boolean state
// (CLAUDE.md 4.11 / ADR-045). isError is checked before empty so a failed
// fetch never collapses into 'empty' — otherwise the reassuring "nothing to
// chase" copy would paper over silent data loss (ADR-045).
function getCohortStatus({
  isPending,
  isError,
  items,
}: {
  isPending: boolean
  isError: boolean
  items: NotYetActiveMemberResponse[]
}): CohortStatus {
  if (isPending) return 'loading'
  if (isError) return 'error'
  if (items.length === 0) return 'empty'
  return 'populated'
}

function CohortSection({
  items,
  total,
  isPending,
  isError,
  onRetry,
  isRetrying,
}: {
  items: NotYetActiveMemberResponse[]
  total: number
  isPending: boolean
  isError: boolean
  onRetry: () => void
  isRetrying: boolean
}) {
  const { t } = useTranslation('migration')
  const status = getCohortStatus({ isPending, isError, items })

  return (
    <section data-test="migration-cohort" className="rounded-large border border-divider p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-foreground">{t('cohortTitle')}</h2>
        {total > 0 && (
          <span className="text-xs text-default-500">{t('cohortCount', { count: total })}</span>
        )}
      </div>

      {status === 'loading' && (
        <div className="flex justify-center py-6">
          <Spinner size="sm" />
        </div>
      )}

      {status === 'error' && (
        <ErrorState
          icon={<Users className="h-8 w-8" />}
          message={t('cohortFailed')}
          onRetry={onRetry}
          isRetrying={isRetrying}
        />
      )}

      {status === 'empty' && (
        <div className="flex flex-col items-center gap-2 py-6">
          <Users className="h-8 w-8 text-default-300" />
          <p className="text-center text-sm text-default-500">{t('cohortEmpty')}</p>
        </div>
      )}

      {status === 'populated' && (
        <ul className="flex flex-col gap-1">
          {items.map((m) => (
            <li
              key={m.userId}
              data-test="cohort-member"
              className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-default-100"
            >
              <Avatar
                name={resolveDisplayName(m)}
                src={m.avatarUrl ?? undefined}
                size="sm"
                showFallback
                classNames={{ base: 'h-8 w-8', name: 'text-xs' }}
              />
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-sm text-foreground">{resolveDisplayName(m)}</span>
                <span className="truncate text-xs text-default-400">
                  {t('joinedAt', { date: new Date(m.joinedAt).toLocaleDateString() })}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
