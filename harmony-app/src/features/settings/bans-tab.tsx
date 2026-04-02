import { Avatar, Button, Spinner } from '@heroui/react'
import { AlertTriangle, ShieldAlert, ShieldOff, UserX } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { type MemberRole, ROLE_HIERARCHY } from '@/features/members'
import { useBans, useUnbanMember } from './hooks/use-bans'

interface BansTabProps {
  serverId: string
  callerRole: MemberRole
}

export function BansTab({ serverId, callerRole }: BansTabProps) {
  const { t } = useTranslation('settings')
  const isAdmin = ROLE_HIERARCHY[callerRole] >= ROLE_HIERARCHY.admin
  const { data, isPending, isError } = useBans(serverId)
  const unban = useUnbanMember(serverId)
  const bans = data?.items ?? []

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
        data-test="settings-bans-error"
        className="flex flex-col items-center justify-center gap-2 py-12"
      >
        <AlertTriangle className="h-10 w-10 text-danger-300" />
        <p className="text-sm text-default-500">{t('bansLoadError')}</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-foreground">{t('bansTitle')}</h2>
        <p className="mt-1 text-sm text-default-500">{t('bansDescription')}</p>
      </div>

      {bans.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-2 py-12">
          <ShieldOff className="h-10 w-10 text-default-300" />
          <p className="text-sm text-default-500">{t('noBannedUsers')}</p>
        </div>
      )}

      <div data-test="settings-ban-list" className="space-y-1">
        {bans.map((ban) => {
          const banDate = new Date(ban.createdAt).toLocaleDateString()

          return (
            <div
              key={ban.userId}
              className="flex items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-default-100"
              data-test="ban-row"
              data-user-id={ban.userId}
            >
              <Avatar
                name={ban.userId.slice(0, 2)}
                size="sm"
                showFallback
                icon={<UserX className="h-4 w-4" />}
                classNames={{ base: 'h-8 w-8 shrink-0', name: 'text-xs' }}
              />
              <div className="flex-1 overflow-hidden">
                <span className="truncate text-sm font-medium text-foreground">{ban.userId}</span>
                <div className="flex items-center gap-2">
                  {ban.reason !== undefined && ban.reason !== null && (
                    <span className="truncate text-xs text-default-400">{ban.reason}</span>
                  )}
                  <span className="text-xs text-default-400">{banDate}</span>
                </div>
              </div>
              <Button
                size="sm"
                variant="flat"
                color="success"
                onPress={() => unban.mutate(ban.userId)}
                isLoading={unban.isPending && unban.variables === ban.userId}
                data-test="unban-button"
              >
                {t('unban')}
              </Button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
