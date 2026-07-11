import {
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownSection,
  DropdownTrigger,
} from '@heroui/react'
import { MessageSquare, UserPlus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useCreateDm } from '@/features/dms'
import { useBlocks, useFriendRequests, useFriends, useSendFriendRequest } from '@/features/friends'
import type { AssignRoleRequest } from '@/lib/api'
import { useChangeRole } from './hooks/use-change-role'
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
  const outranksTarget = isSelf === false && callerRank > targetRank

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

  const roles: Array<{ key: AssignRoleRequest['role']; label: string }> = []
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
  const { t: tFriends } = useTranslation('friends')
  const changeRole = useChangeRole(serverId)
  const createDm = useCreateDm()
  const sendFriendRequest = useSendFriendRequest()
  const perms = usePermissions(callerRole, targetRole, isSelf)
  const assignableRoles = useAssignableRoles(callerRole, targetRole)

  // Relationship state derives from the three cached lists (warm via §5.2
  // eager mounting) — no per-user endpoint, no RelationshipState domain model.
  const friends = useFriends()
  const blocks = useBlocks()
  const outgoing = useFriendRequests('outgoing')
  const isFriend = (friends.data ?? []).some((f) => f.user.id === targetUserId)
  const isBlocked = (blocks.data ?? []).some((b) => b.user.id === targetUserId)
  const hasOutgoingPending = (outgoing.data ?? []).some((r) => r.user.id === targetUserId)

  const hasModerationAction = perms.canChangeRole || perms.canKick || perms.canBan
  // WHY: "Send Message" is always available for non-self members,
  // so the menu is never empty when viewing another user.
  const canSendMessage = isSelf === false
  // Add Friend: only for non-self, not-yet-friends. Disabled (with a reason
  // label) when blocked or an outgoing request already exists (CLAUDE.md §6:
  // disable the UI before the 403).
  const showAddFriend = isSelf === false && isFriend === false
  const addFriend = {
    show: showAddFriend,
    disabled: isBlocked || hasOutgoingPending || sendFriendRequest.isPending,
    label: isBlocked
      ? tFriends('blocked')
      : hasOutgoingPending
        ? tFriends('friendRequestSent')
        : tFriends('addFriendAction'),
    onPress: () => sendFriendRequest.mutate({ addresseeId: targetUserId }),
  }

  function handleRoleChange(role: AssignRoleRequest['role']) {
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
    <Dropdown
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      placement="bottom-start"
      // WHY: data-test on Dropdown flows to the Popover wrapper (single visible DOM
      // element when open). Placing it on DropdownMenu causes HeroUI to duplicate it
      // onto both the base <div> and the <ul> — breaking Playwright strict-mode.
      data-test="member-context-menu"
    >
      <DropdownTrigger>{children}</DropdownTrigger>
      <DropdownMenu
        aria-label={t('memberActions', { username: targetUsername })}
        disabledKeys={[
          ...(canSendMessage === false && hasModerationAction === false && addFriend.show === false
            ? ['no-actions']
            : []),
          ...(addFriend.disabled ? ['add-friend'] : []),
        ]}
      >
        {canSendMessage === false && hasModerationAction === false && addFriend.show === false ? (
          <DropdownItem key="no-actions" className="text-default-400" data-test="no-actions-item">
            {t('noActionsAvailable')}
          </DropdownItem>
        ) : (
          // WHY: Called as a function, NOT rendered as <ContextMenuActions />.
          // React Aria's Collection system (used by DropdownMenu) iterates children
          // and calls type.getCollectionNode() on each. A custom component wrapper
          // doesn't have getCollectionNode → "type.getCollectionNode is not a function"
          // crash. Calling as a function returns a Fragment whose DropdownSection
          // children get flattened into the Collection directly.
          renderContextMenuActions({
            t,
            perms,
            canSendMessage,
            addFriend,
            assignableRoles,
            targetUsername,
            onRoleChange: handleRoleChange,
            onSendMessage: handleSendMessage,
            onKick,
            onBan,
          })
        )}
      </DropdownMenu>
    </Dropdown>
  )
}

/** WHY a plain function (not a component): React Aria Collections require children of
 * DropdownMenu to have a static getCollectionNode method. Rendering as <ContextMenuActions />
 * creates a component boundary that Collection can't process. Called as renderContextMenuActions(),
 * the returned Fragment is flattened and Collection sees DropdownSection nodes directly. */
function renderContextMenuActions({
  t,
  perms,
  canSendMessage,
  addFriend,
  assignableRoles,
  targetUsername,
  onRoleChange,
  onSendMessage,
  onKick,
  onBan,
}: {
  t: (key: string, options?: Record<string, string>) => string
  perms: { canChangeRole: boolean; canKick: boolean; canBan: boolean }
  canSendMessage: boolean
  addFriend: { show: boolean; disabled: boolean; label: string; onPress: () => void }
  assignableRoles: Array<{ key: AssignRoleRequest['role']; label: string }>
  targetUsername: string
  onRoleChange: (role: AssignRoleRequest['role']) => void
  onSendMessage: () => void
  onKick: () => void
  onBan: () => void
}) {
  const hasModerationAction = perms.canChangeRole || perms.canKick || perms.canBan
  const hasContactAction = canSendMessage || addFriend.show

  return (
    <>
      {hasContactAction && (
        <DropdownSection showDivider={hasModerationAction}>
          {[
            ...(canSendMessage
              ? [
                  <DropdownItem
                    key="send-message"
                    startContent={<MessageSquare className="h-4 w-4" />}
                    onPress={onSendMessage}
                    data-test="send-message-item"
                  >
                    {t('sendMessage', { username: targetUsername })}
                  </DropdownItem>,
                ]
              : []),
            ...(addFriend.show
              ? [
                  <DropdownItem
                    key="add-friend"
                    startContent={<UserPlus className="h-4 w-4" />}
                    onPress={addFriend.onPress}
                    data-test="add-friend-item"
                  >
                    {addFriend.label}
                  </DropdownItem>,
                ]
              : []),
          ]}
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
      {perms.canKick && (
        <DropdownSection>
          {[
            <DropdownItem
              key="kick"
              className="text-danger"
              color="danger"
              onPress={onKick}
              data-test="kick-member-item"
            >
              {t('kickUser', { username: targetUsername })}
            </DropdownItem>,
            ...(perms.canBan
              ? [
                  <DropdownItem
                    key="ban"
                    className="text-danger"
                    color="danger"
                    onPress={onBan}
                    data-test="ban-member-item"
                  >
                    {t('banUser', { username: targetUsername })}
                  </DropdownItem>,
                ]
              : []),
          ]}
        </DropdownSection>
      )}
    </>
  )
}
