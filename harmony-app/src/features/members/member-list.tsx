import { Avatar, Spinner } from '@heroui/react'
import { Users } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ErrorState } from '@/components/shared/error-state'
import { useAuthStore } from '@/features/auth'
import { StatusIndicator, usePresenceStore } from '@/features/presence'
import {
  FoundingBadge,
  OfficialBadge,
  ProfilePopover,
  useOfficialBadges,
} from '@/features/profiles'
import type { MemberResponse, UserStatus } from '@/lib/api'
import { resolveDisplayName } from '@/lib/display-name'
import { cn } from '@/lib/utils'
import { BanDialog } from './ban-dialog'
import { useMembers } from './hooks/use-members'
import { KickDialog } from './kick-dialog'
import { MemberContextMenu } from './member-context-menu'
import type { MemberRole } from './moderation-types'
import { getMemberRole } from './moderation-types'
import { RoleBadge } from './role-badge'

interface MemberListProps {
  serverId: string | null
  serverName: string | null
  onNavigateDm: (serverId: string, channelId: string) => void
}

/** WHY: Semantic HeroUI tokens for role name colors (ADR-044). */
const ROLE_NAME_CLASS: Record<MemberRole, string> = {
  owner: 'text-warning',
  admin: 'text-danger',
  moderator: 'text-primary',
  member: 'text-foreground',
}

/** Section order and labels for role grouping. */
const ROLE_SECTIONS: MemberRole[] = ['owner', 'admin', 'moderator', 'member']

/**
 * WHY: Groups members by role for the sidebar display. Within each group,
 * members are sorted alphabetically by display name.
 */
function useGroupedMembers(members: MemberResponse[]) {
  return useMemo(() => {
    const groups: Record<MemberRole, MemberResponse[]> = {
      owner: [],
      admin: [],
      moderator: [],
      member: [],
    }

    for (const member of members) {
      const role = getMemberRole(member)
      groups[role].push(member)
    }

    // WHY: Sort alphabetically within each role group.
    for (const role of ROLE_SECTIONS) {
      groups[role].sort((a, b) => {
        const nameA = resolveDisplayName(a).toLowerCase()
        const nameB = resolveDisplayName(b).toLowerCase()
        return nameA.localeCompare(nameB)
      })
    }

    return groups
  }, [members])
}

/**
 * WHY: Combines API member data with presence for a Discord-style member list.
 * Members are grouped by role (owner, admin, moderator, member) with role
 * badges and color-coded display names.
 */
export function MemberList({ serverId, serverName, onNavigateDm }: MemberListProps) {
  const { t } = useTranslation('members')
  const { data, isPending, isError, refetch, isRefetching } = useMembers(serverId)
  const presenceMap = usePresenceStore((s) => s.presenceMap)
  const currentUserId = useAuthStore((s) => s.user?.id ?? '')
  const members = data?.items ?? []
  const groups = useGroupedMembers(members)

  // WHY: Find the current user's role from the member list for permission checks.
  const callerRole = useMemo<MemberRole>(() => {
    const self = members.find((m) => m.userId === currentUserId)
    return self !== undefined ? getMemberRole(self) : 'member'
  }, [members, currentUserId])

  // WHY: Dialog state is lifted here so context menu items can trigger
  // the ban/kick dialogs from any member row.
  const [kickTarget, setKickTarget] = useState<{ id: string; username: string } | null>(null)
  const [banTarget, setBanTarget] = useState<{ id: string; username: string } | null>(null)

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

  if (isError && data === undefined) {
    return (
      <div className="flex h-full flex-col bg-default-100">
        <div className="flex h-12 items-center border-b border-divider px-4">
          <span className="font-semibold text-foreground">{t('members')}</span>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <ErrorState
            icon={<Users className="h-10 w-10" />}
            message={t('failedToLoadMembers')}
            onRetry={() => refetch()}
            isRetrying={isRefetching}
          />
        </div>
      </div>
    )
  }

  return (
    <div data-test="member-list" className="flex h-full flex-col bg-default-100">
      <div className="flex h-12 items-center border-b border-divider px-4">
        <span data-test="member-count" className="font-semibold text-foreground">
          {t('membersWithCount', { total: members.length })}
        </span>
      </div>
      <div className={`flex-1 overflow-y-auto px-2 py-2${isError ? ' opacity-70' : ''}`}>
        {ROLE_SECTIONS.map((role) => {
          const sectionMembers = groups[role]
          if (sectionMembers.length === 0) return null

          return (
            <div key={role}>
              <div className="px-2 pt-4 pb-1 first:pt-2">
                <span className="text-xs font-semibold uppercase text-default-500">
                  {t(`roleSection_${role}`, { count: sectionMembers.length })}
                </span>
              </div>
              {sectionMembers.map((member) => (
                <MemberRow
                  key={member.userId}
                  member={member}
                  role={getMemberRole(member)}
                  status={presenceMap.get(member.userId) ?? null}
                  callerRole={callerRole}
                  currentUserId={currentUserId}
                  serverId={serverId}
                  onKick={(target) => setKickTarget(target)}
                  onBan={(target) => setBanTarget(target)}
                  onNavigateDm={onNavigateDm}
                />
              ))}
            </div>
          )
        })}

        {members.length === 0 && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-8">
            <Users className="h-10 w-10 text-default-300" />
            <p className="text-center text-sm text-default-500">{t('noMembersYet')}</p>
          </div>
        )}
      </div>

      {kickTarget !== null && serverId !== null && (
        <KickDialog
          isOpen
          onClose={() => setKickTarget(null)}
          serverId={serverId}
          targetUser={kickTarget}
          serverName={serverName ?? ''}
        />
      )}

      {banTarget !== null && serverId !== null && (
        <BanDialog
          isOpen
          onClose={() => setBanTarget(null)}
          serverId={serverId}
          targetUser={banTarget}
          serverName={serverName ?? ''}
        />
      )}
    </div>
  )
}

function MemberRow({
  member,
  role,
  status,
  callerRole,
  currentUserId,
  serverId,
  onKick,
  onBan,
  onNavigateDm,
}: {
  member: MemberResponse
  role: MemberRole
  status: UserStatus | null
  callerRole: MemberRole
  currentUserId: string
  serverId: string
  onKick: (target: { id: string; username: string }) => void
  onBan: (target: { id: string; username: string }) => void
  onNavigateDm: (serverId: string, channelId: string) => void
}) {
  const displayName = resolveDisplayName(member)
  const isSelf = member.userId === currentUserId
  const officialUserIds = useOfficialBadges()
  const [isContextMenuOpen, setIsContextMenuOpen] = useState(false)

  function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault()
    setIsContextMenuOpen(true)
  }

  // WHY the wrapper + invisible anchor: the row needs TWO overlays — a
  // left-press ProfilePopover (the card) and a right-click MemberContextMenu
  // (moderation). HeroUI triggers each clone their single DOM child, so they
  // cannot share one node. The button is the popover trigger; the context menu
  // anchors to a pointer-events-none span covering the row, opened via the
  // wrapper's onContextMenu — the two coexist without fighting for the trigger.
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: onContextMenu (right-click) opens the moderation menu; the primary press action lives on the inner button (the ProfilePopover trigger), which carries the interactive semantics
    <div className="relative" onContextMenu={handleContextMenu}>
      <ProfilePopover userId={member.userId} serverId={serverId}>
        <button
          type="button"
          data-test="member-item"
          data-user-id={member.userId}
          className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-default-200"
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
          <span
            data-test="member-username"
            className={cn('truncate text-sm', ROLE_NAME_CLASS[role])}
          >
            {displayName}
          </span>
          <RoleBadge role={role} />
          <OfficialBadge isOfficial={officialUserIds.has(member.userId)} />
          <FoundingBadge isFounding={member.isFounding} />
        </button>
      </ProfilePopover>
      <MemberContextMenu
        serverId={serverId}
        callerRole={callerRole}
        targetUserId={member.userId}
        targetUsername={member.username}
        targetRole={role}
        isSelf={isSelf}
        isOpen={isContextMenuOpen}
        onOpenChange={setIsContextMenuOpen}
        onKick={() => onKick({ id: member.userId, username: member.username })}
        onBan={() => onBan({ id: member.userId, username: member.username })}
        onNavigateDm={onNavigateDm}
      >
        <span aria-hidden className="pointer-events-none absolute inset-0" />
      </MemberContextMenu>
    </div>
  )
}
