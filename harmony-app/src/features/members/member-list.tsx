import { Avatar, Spinner } from '@heroui/react'
import { Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { StatusIndicator, usePresenceStore } from '@/features/presence'
import type { MemberResponse, UserStatus } from '@/lib/api'
import { useMembers } from './hooks/use-members'

interface MemberListProps {
  serverId: string | null
}

/**
 * WHY: Combines API member data with presence for a Discord-style member list.
 * Online/presence-active members show their status indicator; offline members
 * still appear (from the API) but without a presence dot.
 */
export function MemberList({ serverId }: MemberListProps) {
  const { t } = useTranslation('members')
  const { data, isPending, isError } = useMembers(serverId)
  const presenceMap = usePresenceStore((s) => s.presenceMap)

  if (serverId === null) {
    return (
      <div className="flex h-full flex-col bg-default-100">
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4">
          <Users className="h-10 w-10 text-default-300" />
          <p className="text-center text-sm text-default-500">{t('selectServerToViewMembers')}</p>
        </div>
      </div>
    )
  }

  if (isPending) {
    return (
      <div className="flex h-full flex-col bg-default-100">
        <div className="flex h-12 items-center border-b border-divider px-4">
          <span className="font-semibold text-foreground">{t('members')}</span>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <Spinner size="sm" />
        </div>
      </div>
    )
  }

  if (isError) {
    return (
      <div className="flex h-full flex-col bg-default-100">
        <div className="flex h-12 items-center border-b border-divider px-4">
          <span className="font-semibold text-foreground">{t('members')}</span>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4">
          <Users className="h-10 w-10 text-default-300" />
          <p className="text-center text-sm text-danger">{t('failedToLoadMembers')}</p>
        </div>
      </div>
    )
  }

  const members = data?.items ?? []
  const total = data?.total ?? 0

  // WHY: Split members into online (any presence status) and offline (not in presence map)
  // so online members appear at the top, matching Discord's member list layout.
  const onlineMembers: Array<{ member: MemberResponse; status: UserStatus }> = []
  const offlineMembers: MemberResponse[] = []

  for (const member of members) {
    const status = presenceMap.get(member.userId)
    if (status !== undefined) {
      onlineMembers.push({ member, status })
    } else {
      offlineMembers.push(member)
    }
  }

  return (
    <div data-test="member-list" className="flex h-full flex-col bg-default-100">
      <div className="flex h-12 items-center border-b border-divider px-4">
        <span data-test="member-count" className="font-semibold text-foreground">
          {t('membersWithCount', { total })}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {onlineMembers.length > 0 && (
          <div>
            <div className="px-2 pt-2 pb-1">
              <span className="text-xs font-semibold uppercase text-default-500">
                {t('onlineWithCount', { count: onlineMembers.length })}
              </span>
            </div>
            {onlineMembers.map(({ member, status }) => (
              <MemberRow key={member.userId} member={member} status={status} />
            ))}
          </div>
        )}

        {offlineMembers.length > 0 && (
          <div>
            <div className="px-2 pt-4 pb-1">
              <span className="text-xs font-semibold uppercase text-default-500">
                {t('offlineWithCount', { count: offlineMembers.length })}
              </span>
            </div>
            {offlineMembers.map((member) => (
              <MemberRow key={member.userId} member={member} status={null} />
            ))}
          </div>
        )}

        {members.length === 0 && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-8">
            <Users className="h-10 w-10 text-default-300" />
            <p className="text-center text-sm text-default-500">{t('noMembersYet')}</p>
          </div>
        )}
      </div>
    </div>
  )
}

function MemberRow({ member, status }: { member: MemberResponse; status: UserStatus | null }) {
  const displayName = member.nickname ?? member.username

  return (
    <div
      data-test="member-item"
      data-user-id={member.userId}
      className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-default-200"
    >
      <div className="relative">
        <Avatar
          name={displayName}
          src={member.avatarUrl ?? undefined}
          size="sm"
          showFallback
          classNames={{ base: 'h-8 w-8', name: 'text-xs' }}
        />
        {status !== null && (
          <div data-test="member-status" className="absolute -bottom-0.5 -right-0.5">
            <StatusIndicator status={status} size="sm" />
          </div>
        )}
      </div>
      <span data-test="member-username" className="truncate text-sm text-foreground">
        {displayName}
      </span>
    </div>
  )
}
