import {
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownSection,
  DropdownTrigger,
} from '@heroui/react'
import { LogOut, Plus, Settings, UserPlus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ROLE_HIERARCHY, useMyMemberRole } from '@/features/members'

interface ServerContextMenuProps {
  serverId: string
  children: React.ReactNode
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  onInvite: () => void
  onSettings: () => void
  onCreateChannel: () => void
  onLeave: () => void
}

/**
 * Right-click context menu for a server icon in the left rail. Mirrors the
 * server-header dropdown's actions and permission gates (moderator+ for
 * Settings, admin+ for Create Channel), and the member-row context-menu shape:
 * a controlled HeroUI Dropdown whose trigger wraps an invisible full-cover
 * anchor, with menu items produced by a plain function call (React-Aria
 * Collection can't process a component wrapper — see renderServerContextMenuActions).
 *
 * The parent (server-list) is responsible for selecting the right-clicked
 * server before each action fires, so Settings/Invite/Create-Channel — which
 * target the ACTIVE server — act on the right-clicked one, not whatever was
 * previously active.
 */
export function ServerContextMenu({
  serverId,
  children,
  isOpen,
  onOpenChange,
  onInvite,
  onSettings,
  onCreateChannel,
  onLeave,
}: ServerContextMenuProps) {
  const { t } = useTranslation('channels')
  // WHY isOpen ? serverId : null: only fetch this server's members (to derive
  // the caller's role for permission gating) once the menu is actually open —
  // avoids one members request per server icon on mount. useMembers is disabled
  // on null and the role defaults to 'member', hiding the gated items until the
  // real role loads (fail-closed, matching CLAUDE.md §6 "disable before 403").
  const { role } = useMyMemberRole(isOpen ? serverId : null)
  const canOpenSettings = ROLE_HIERARCHY[role] >= ROLE_HIERARCHY.moderator
  const canManageChannels = ROLE_HIERARCHY[role] >= ROLE_HIERARCHY.admin

  return (
    <Dropdown
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      placement="right-start"
      data-test="server-context-menu"
    >
      <DropdownTrigger>{children}</DropdownTrigger>
      <DropdownMenu aria-label={t('serverOptions')}>
        {renderServerContextMenuActions({
          t,
          canOpenSettings,
          canManageChannels,
          onInvite,
          onSettings,
          onCreateChannel,
          onLeave,
        })}
      </DropdownMenu>
    </Dropdown>
  )
}

/** WHY a plain function (not a component): React Aria Collections require children
 * of DropdownMenu to expose a static getCollectionNode method. Rendering as
 * <ServerContextMenuActions /> creates a component boundary the Collection can't
 * process ("type.getCollectionNode is not a function"). Called as a function, the
 * returned Fragment is flattened and Collection sees the DropdownSection nodes
 * directly — same constraint as the member context menu. */
function renderServerContextMenuActions({
  t,
  canOpenSettings,
  canManageChannels,
  onInvite,
  onSettings,
  onCreateChannel,
  onLeave,
}: {
  t: (key: string) => string
  canOpenSettings: boolean
  canManageChannels: boolean
  onInvite: () => void
  onSettings: () => void
  onCreateChannel: () => void
  onLeave: () => void
}) {
  return (
    <>
      <DropdownSection showDivider>
        {[
          <DropdownItem
            key="invite"
            startContent={<UserPlus className="h-4 w-4" />}
            onPress={onInvite}
            data-test="server-context-invite-item"
          >
            {t('servers:invitePeople')}
          </DropdownItem>,
          ...(canOpenSettings
            ? [
                <DropdownItem
                  key="settings"
                  startContent={<Settings className="h-4 w-4" />}
                  onPress={onSettings}
                  data-test="server-context-settings-item"
                >
                  {t('serverSettings')}
                </DropdownItem>,
              ]
            : []),
          ...(canManageChannels
            ? [
                <DropdownItem
                  key="create-channel"
                  startContent={<Plus className="h-4 w-4" />}
                  onPress={onCreateChannel}
                  data-test="server-context-create-channel-item"
                >
                  {t('createChannel')}
                </DropdownItem>,
              ]
            : []),
        ]}
      </DropdownSection>
      <DropdownSection>
        {[
          // WHY always shown (incl. owner): mirrors the server-header dropdown.
          // The backend is the enforcement point for owner-can't-leave; the
          // confirm + API rejection (toast) handle that case, so no role gate here.
          <DropdownItem
            key="leave"
            className="text-danger"
            color="danger"
            startContent={<LogOut className="h-4 w-4" />}
            onPress={onLeave}
            data-test="server-context-leave-item"
          >
            {t('leaveServer')}
          </DropdownItem>,
        ]}
      </DropdownSection>
    </>
  )
}
