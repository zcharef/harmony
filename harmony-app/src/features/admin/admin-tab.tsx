import { Button, Chip, Input, Spinner } from '@heroui/react'
import { Search } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AdminUserSummaryResponse, Plan } from '@/lib/api'
import { useSearchUsers } from './hooks/use-search-users'
import { useSetUserPlan } from './hooks/use-set-user-plan'
import { useUserQuota } from './hooks/use-user-quota'

/** The plan tiers the founder can assign, in ascending order. */
const PLANS: readonly Plan[] = ['free', 'supporter', 'creator'] as const

/**
 * Founder-only admin panel: search a user → view their plan + quota usage → set
 * their plan (Free/Supporter/Creator) with a confirmation step. Rendered only
 * when `me.isPlatformAdmin === true`; the backend is the real gate.
 */
export function AdminTab() {
  const { t } = useTranslation('admin')
  const [searchInput, setSearchInput] = useState('')
  const [submittedQuery, setSubmittedQuery] = useState('')
  const [selected, setSelected] = useState<AdminUserSummaryResponse | null>(null)

  const search = useSearchUsers(submittedQuery)

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    setSubmittedQuery(searchInput)
  }

  return (
    <div className="flex flex-col gap-4" data-test="admin-tab">
      <p className="text-small text-default-500">{t('description')}</p>

      <form onSubmit={onSubmit} className="flex items-end gap-2" data-test="admin-search-form">
        <Input
          label={t('searchLabel')}
          placeholder={t('searchPlaceholder')}
          value={searchInput}
          onValueChange={setSearchInput}
          startContent={<Search className="size-4 text-default-400" />}
          size="sm"
          data-test="admin-search-input"
        />
        <Button
          type="submit"
          color="primary"
          size="sm"
          isDisabled={searchInput.trim().length === 0}
          data-test="admin-search-submit"
        >
          {t('searchButton')}
        </Button>
      </form>

      {search.isFetching && <Spinner size="sm" aria-label={t('searching')} />}

      {search.isError && (
        <p className="text-small text-danger" data-test="admin-search-error">
          {t('searchFailed')}
        </p>
      )}

      {search.data && search.data.items.length === 0 && (
        <p className="text-small text-default-500" data-test="admin-search-empty">
          {t('noResults')}
        </p>
      )}

      {search.data && search.data.items.length > 0 && (
        <ul className="flex flex-col gap-1" data-test="admin-results">
          {search.data.items.map((user) => (
            <li key={user.id}>
              <UserRow
                user={user}
                isSelected={selected?.id === user.id}
                onSelect={() => setSelected(user)}
                planLabel={t(`plan_${user.plan}`)}
              />
            </li>
          ))}
        </ul>
      )}

      {selected !== null && (
        <UserDetail
          key={selected.id}
          user={selected}
          onPlanChanged={(plan) => setSelected({ ...selected, plan })}
        />
      )}
    </div>
  )
}

interface UserRowProps {
  user: AdminUserSummaryResponse
  isSelected: boolean
  onSelect: () => void
  planLabel: string
}

function UserRow({ user, isSelected, onSelect, planLabel }: UserRowProps) {
  return (
    <Button
      variant={isSelected ? 'flat' : 'light'}
      color={isSelected ? 'primary' : 'default'}
      onPress={onSelect}
      className="h-auto justify-between py-2"
      fullWidth
      data-test="admin-result"
      data-user-id={user.id}
    >
      <span className="flex flex-col items-start">
        <span className="font-medium">{user.displayName ?? user.username}</span>
        <span className="text-tiny text-default-500">@{user.username}</span>
      </span>
      <Chip size="sm" variant="flat" color="secondary">
        {planLabel}
      </Chip>
    </Button>
  )
}

interface UserDetailProps {
  user: AdminUserSummaryResponse
  onPlanChanged: (plan: Plan) => void
}

function UserDetail({ user, onPlanChanged }: UserDetailProps) {
  const { t } = useTranslation('admin')
  const quota = useUserQuota(user.id)
  const setPlan = useSetUserPlan()
  const [chosenPlan, setChosenPlan] = useState<Plan>(user.plan)
  const [confirming, setConfirming] = useState(false)

  const dirty = chosenPlan !== user.plan

  function apply() {
    setPlan.mutate(
      { userId: user.id, plan: chosenPlan },
      {
        onSuccess: (updated) => {
          setConfirming(false)
          onPlanChanged(updated.plan)
        },
      },
    )
  }

  return (
    <div
      className="flex flex-col gap-4 rounded-medium border border-default-200 p-4"
      data-test="admin-user-detail"
    >
      <div className="flex items-center justify-between">
        <div className="flex flex-col">
          <span className="font-semibold">{user.displayName ?? user.username}</span>
          <span className="text-tiny text-default-500">@{user.username}</span>
        </div>
        <div className="flex gap-1">
          {user.isFounding && (
            <Chip size="sm" variant="flat" color="warning">
              {t('badgeFounding')}
            </Chip>
          )}
          {user.isOfficial && (
            <Chip size="sm" variant="flat" color="primary">
              {t('badgeOfficial')}
            </Chip>
          )}
        </div>
      </div>

      <section className="flex flex-col gap-2" data-test="admin-quota">
        <h4 className="text-small font-semibold">{t('quotaTitle')}</h4>
        {quota.isPending && <Spinner size="sm" aria-label={t('loadingQuota')} />}
        {quota.isError && <p className="text-small text-danger">{t('quotaFailed')}</p>}
        {quota.data && (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-small">
            <UsageRow
              label={t('ownedServers')}
              used={quota.data.usage.ownedServers}
              max={quota.data.limits.maxOwnedServers}
            />
            <UsageRow
              label={t('joinedServers')}
              used={quota.data.usage.joinedServers}
              max={quota.data.limits.maxJoinedServers}
            />
            <UsageRow
              label={t('openDms')}
              used={quota.data.usage.openDms}
              max={quota.data.limits.maxOpenDms}
            />
          </dl>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h4 className="text-small font-semibold">{t('planTitle')}</h4>
        <div className="flex flex-wrap gap-2" data-test="admin-plan-options">
          {PLANS.map((plan) => (
            <Button
              key={plan}
              size="sm"
              variant={chosenPlan === plan ? 'solid' : 'bordered'}
              color={chosenPlan === plan ? 'primary' : 'default'}
              onPress={() => {
                setChosenPlan(plan)
                setConfirming(false)
              }}
              data-test="admin-plan-option"
              data-plan={plan}
            >
              {t(`plan_${plan}`)}
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {confirming === false ? (
            <Button
              color="primary"
              size="sm"
              isDisabled={dirty === false}
              onPress={() => setConfirming(true)}
              data-test="admin-plan-apply"
            >
              {t('applyPlan')}
            </Button>
          ) : (
            <div className="flex gap-2" data-test="admin-plan-confirm">
              <Button
                color="danger"
                size="sm"
                isLoading={setPlan.isPending}
                onPress={apply}
                data-test="admin-plan-confirm-yes"
              >
                {t('confirmApply', { plan: t(`plan_${chosenPlan}`) })}
              </Button>
              <Button
                variant="light"
                size="sm"
                isDisabled={setPlan.isPending}
                onPress={() => setConfirming(false)}
                data-test="admin-plan-confirm-cancel"
              >
                {t('cancel')}
              </Button>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

function UsageRow({ label, used, max }: { label: string; used: number; max: number }) {
  return (
    <>
      <dt className="text-default-500">{label}</dt>
      <dd className="text-right font-medium tabular-nums">
        {used} / {max}
      </dd>
    </>
  )
}
