import {
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownSection,
  DropdownTrigger,
} from '@heroui/react'
import { MessageSquare } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useCreateDm } from '@/features/dms'
import { useChangeRole } from './hooks/use-change-role'
import type { ChangeRoleRequest } from './moderation-types'
import { type MemberRole, ROLE_HIERARCHY } from './moderation-types'

interface MemberContextMenuProps {
  serverId: string
  callerRole: MemberRole
  targetUserId: string
  targetUsername: string
  targetRole: MemberRole
  isSelf: boolean
  children: React.ReactNode
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  onKick: () => void
  onBan: () => void
  onNavigateDm: (serverId: string, channelId: string) => void
}

/** WHY extracted: Keeps cognitive complexity below Biome's limit of 15. */
function usePermissions(callerRole: MemberRole, targetRole: MemberRole, isSelf: boolean) {
  const callerRank = ROLE_HIERARCHY[callerRole]
  const targetRank = ROLE_HIERARCHY[targetRole]
  const outranksTarget = !isSelf && callerRank > targetRank

  return {
    canChangeRole: outranksTarget && callerRank >= ROLE_HIERARCHY.admin,
    canKick: outranksTarget && callerRank >= ROLE_HIERARCHY.moderator,
    canBan: outranksTarget && callerRank >= ROLE_HIERARCHY.admin,
  }
}

/** WHY extracted: Builds the list of roles the caller can assign to the target. */
function useAssignableRoles(callerRole: MemberRole, targetRole: MemberRole) {
  const { t } = useTranslation('members')
  const callerRank = ROLE_HIERARCHY[callerRole]

  const roles: Array<{ key: ChangeRoleRequest['role']; label: string }> = []
  if (callerRank > ROLE_HIERARCHY.admin) {
    roles.push({ key: 'admin', label: t('roleAdmin') })
  }
  if (callerRank > ROLE_HIERARCHY.moderator) {
    roles.push({ key: 'moderator', label: t('roleModerator') })
  }
  roles.push({ key: 'member', label: t('roleMember') })

  // WHY: Filter out the target's current role — no point showing a no-op.
  return roles.filter((r) => r.key !== targetRole)
}

export function MemberContextMenu({
  serverId,
  callerRole,
  targetUserId,
  targetUsername,
  targetRole,
  isSelf,
  children,
  isOpen,
  onOpenChange,
  onKick,
  onBan,
  onNavigateDm,
}: MemberContextMenuProps) {
  const { t } = useTranslation('members')
  const changeRole = useChangeRole(serverId)
  const createDm = useCreateDm()
  const perms = usePermissions(callerRole, targetRole, isSelf)
  const assignableRoles = useAssignableRoles(callerRole, targetRole)

  const hasModerationAction = perms.canChangeRole || perms.canKick || perms.canBan
  // WHY: "Send Message" is always available for non-self members,
  // so the menu is never empty when viewing another user.
  const canSendMessage = !isSelf

  function handleRoleChange(role: ChangeRoleRequest['role']) {
    changeRole.mutate({ userId: targetUserId, role })
  }

  function handleSendMessage() {
    createDm.mutate(targetUserId, {
      onSuccess: (data) => {
        onNavigateDm(data.serverId, data.channelId)
      },
    })
  }

  return (
    <Dropdown isOpen={isOpen} onOpenChange={onOpenChange} placement="bottom-start">
      <DropdownTrigger>{children}</DropdownTrigger>
      <DropdownMenu
        aria-label={t('memberActions', { username: targetUsername })}
        disabledKeys={!canSendMessage && !hasModerationAction ? ['no-actions'] : []}
      >
        {!canSendMessage && !hasModerationAction ? (
          <DropdownItem key="no-actions" className="text-default-400">
            {t('noActionsAvailable')}
          </DropdownItem>
        ) : (
          <ContextMenuActions
            perms={perms}
            canSendMessage={canSendMessage}
            assignableRoles={assignableRoles}
            targetUsername={targetUsername}
            onRoleChange={handleRoleChange}
            onSendMessage={handleSendMessage}
            onKick={onKick}
            onBan={onBan}
          />
        )}
      </DropdownMenu>
    </Dropdown>
  )
}

/** WHY extracted: Isolates the conditional rendering branches to stay under complexity limit. */
function ContextMenuActions({
  perms,
  canSendMessage,
  assignableRoles,
  targetUsername,
  onRoleChange,
  onSendMessage,
  onKick,
  onBan,
}: {
  perms: { canChangeRole: boolean; canKick: boolean; canBan: boolean }
  canSendMessage: boolean
  assignableRoles: Array<{ key: ChangeRoleRequest['role']; label: string }>
  targetUsername: string
  onRoleChange: (role: ChangeRoleRequest['role']) => void
  onSendMessage: () => void
  onKick: () => void
  onBan: () => void
}) {
  const { t } = useTranslation('members')
  const hasModerationAction = perms.canChangeRole || perms.canKick || perms.canBan

  return (
    <>
      {canSendMessage && (
        <DropdownSection showDivider={hasModerationAction}>
          <DropdownItem
            key="send-message"
            startContent={<MessageSquare className="h-4 w-4" />}
            onPress={onSendMessage}
            data-test="send-message-item"
          >
            {t('sendMessage', { username: targetUsername })}
          </DropdownItem>
        </DropdownSection>
      )}
      {perms.canChangeRole && (
        <DropdownSection title={t('changeRole')} showDivider>
          {assignableRoles.map((r) => (
            <DropdownItem
              key={`role-${r.key}`}
              onPress={() => onRoleChange(r.key)}
              data-test={`role-${r.key}-item`}
            >
              {r.label}
            </DropdownItem>
          ))}
        </DropdownSection>
      )}
      {perms.canKick && !perms.canBan && (
        <DropdownSection>
          <DropdownItem
            key="kick"
            className="text-danger"
            color="danger"
            onPress={onKick}
            data-test="kick-member-item"
          >
            {t('kickUser', { username: targetUsername })}
          </DropdownItem>
        </DropdownSection>
      )}
      {perms.canBan && !perms.canKick && (
        <DropdownSection>
          <DropdownItem
            key="ban"
            className="text-danger"
            color="danger"
            onPress={onBan}
            data-test="ban-member-item"
          >
            {t('banUser', { username: targetUsername })}
          </DropdownItem>
        </DropdownSection>
      )}
      {perms.canKick && perms.canBan && (
        <DropdownSection>
          <DropdownItem
            key="kick"
            className="text-danger"
            color="danger"
            onPress={onKick}
            data-test="kick-member-item"
          >
            {t('kickUser', { username: targetUsername })}
          </DropdownItem>
          <DropdownItem
            key="ban"
            className="text-danger"
            color="danger"
            onPress={onBan}
            data-test="ban-member-item"
          >
            {t('banUser', { username: targetUsername })}
          </DropdownItem>
        </DropdownSection>
      )}
    </>
  )
}
