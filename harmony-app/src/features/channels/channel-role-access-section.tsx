import { Spinner, Switch } from '@heroui/react'
import { useTranslation } from 'react-i18next'
import { RoleBadge } from '@/features/members'
import type { Role } from '@/lib/api'
import { useChannelRoleAccess } from './hooks/use-channel-role-access'
import { useSetChannelRoleAccess } from './hooks/use-set-channel-role-access'

/** WHY: admin/owner hold implicit access and are never grantable — only these two. */
const GRANTABLE_ROLES = ['moderator', 'member'] as const satisfies readonly Role[]

interface ChannelRoleAccessSectionProps {
  serverId: string
  channelId: string
}

/**
 * "Role access" block inside the Edit Channel dialog, shown only when the
 * channel is private. One Switch per grantable role reflecting whether a
 * `channel_role_access` grant exists. Load-then-render (CLAUDE.md §4.4): the
 * toggles do not render until the grant set is loaded, so there is no flash of
 * all-OFF then snap-to-real.
 */
export function ChannelRoleAccessSection({ serverId, channelId }: ChannelRoleAccessSectionProps) {
  const { t } = useTranslation('settings')
  const { t: tMembers } = useTranslation('members')
  const { data, isPending, isError, refetch } = useChannelRoleAccess(serverId, channelId, true)
  const setAccess = useSetChannelRoleAccess(serverId, channelId)

  const roleLabel: Record<(typeof GRANTABLE_ROLES)[number], string> = {
    moderator: tMembers('roleModerator'),
    member: tMembers('roleMember'),
  }

  function handleToggle(role: (typeof GRANTABLE_ROLES)[number], selected: boolean) {
    // WHY the guard (not `?? []`): the toggles only render once `data` is loaded,
    // but a bare fallback would send an empty set — silently REVOKING every grant
    // — if `data` were ever unexpectedly undefined. In a security-critical access
    // path, bail rather than issue a destructive write.
    if (data === undefined) return
    // WHY derive from the cache, not a shadow: `data.roles` is the source of
    // truth; the optimistic mutation patches it so the switch reacts instantly.
    const next = selected ? [...data.roles, role] : data.roles.filter((r) => r !== role)
    setAccess.mutate(next)
  }

  return (
    <div className="flex flex-col gap-2" data-test="channel-role-access-section">
      <span className="text-sm font-medium">{t('channelAccessTitle')}</span>

      {isPending ? (
        <Spinner size="sm" data-test="channel-role-access-loading" />
      ) : isError ? (
        // WHY inline, not toast: a passive read the user did not explicitly
        // trigger (ADR-045). The rest of the dialog stays usable.
        <button
          type="button"
          onClick={() => refetch()}
          className="text-left text-xs text-danger"
          data-test="channel-role-access-error"
        >
          {t('channelAccessLoadError')}
        </button>
      ) : (
        <>
          {GRANTABLE_ROLES.map((role) => (
            <Switch
              key={role}
              size="sm"
              // WHY disable while saving: back-to-back toggles would fire
              // overlapping optimistic mutations whose rollbacks could race and
              // leave the grant set inconsistent — one write at a time.
              isDisabled={setAccess.isPending}
              isSelected={data.roles.includes(role)}
              onValueChange={(selected) => handleToggle(role, selected)}
              aria-label={t('channelAccessGrantAria', { role: roleLabel[role] })}
              data-test={`channel-role-access-toggle-${role}`}
            >
              <span className="flex items-center gap-1.5 text-sm">
                <RoleBadge role={role} />
                {roleLabel[role]}
              </span>
            </Switch>
          ))}
          {data.roles.length === 0 && (
            <p className="text-xs text-default-400" data-test="channel-role-access-empty">
              {t('channelAccessEmptyHelp')}
            </p>
          )}
        </>
      )}
    </div>
  )
}
