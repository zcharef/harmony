import {
  Avatar,
  Button,
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownSection,
  DropdownTrigger,
  Spinner,
  Tooltip,
} from '@heroui/react'
import {
  ChevronDown,
  Hash,
  HeadphoneOff,
  Headphones,
  Lock,
  Megaphone,
  Mic,
  MicOff,
  Settings,
  UserPlus,
  Volume2,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ErrorState } from '@/components/shared/error-state'
import { useAuthStore, useCurrentProfile } from '@/features/auth'
import { EncryptedChannelBadge } from '@/features/crypto'
import { ROLE_HIERARCHY, useLeaveServer, useMyMemberRole } from '@/features/members'
import { StatusPicker } from '@/features/preferences'
import { StatusIndicator, useUserStatus } from '@/features/presence'
import { CreateInviteDialog } from '@/features/server-nav'
import { useSettingsUiStore } from '@/features/settings'
import {
  AudioAutoplayPrompt,
  useVoiceConnectionStore,
  VoiceConnectionBar,
  VoiceParticipantList,
} from '@/features/voice'
import type { ChannelResponse } from '@/lib/api'
import { cn } from '@/lib/utils'
import { CreateChannelDialog } from './create-channel-dialog'
import { EditChannelDialog } from './edit-channel-dialog'
import { useChannels } from './hooks/use-channels'
import { useDeleteChannel } from './hooks/use-delete-channel'
import { useUnreadStore } from './stores/unread-store'

function ChannelButton({
  channel,
  isActive,
  canManageChannels,
  onSelect,
  onEdit,
  onDelete,
}: {
  channel: ChannelResponse
  isActive: boolean
  canManageChannels: boolean
  onSelect: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation('channels')
  const unreadCount = useUnreadStore((s) => s.counts[channel.id] ?? 0)

  return (
    <div data-test="channel-item" className="group flex items-center">
      <Button
        data-test="channel-button"
        data-channel-id={channel.id}
        data-channel-name={channel.name}
        variant="light"
        size="sm"
        onPress={onSelect}
        className={cn(
          'flex-1 justify-start gap-1.5 px-2 text-default-500',
          isActive && channel.channelType !== 'voice' && 'bg-default-200 text-foreground',
          unreadCount > 0 && !isActive ? 'font-semibold text-foreground' : 'font-medium',
        )}
      >
        {channel.channelType === 'text' ? (
          <Hash className="h-4 w-4 shrink-0 text-default-500" />
        ) : (
          <Volume2 className="h-4 w-4 shrink-0 text-default-500" />
        )}
        <span className="truncate">{channel.name}</span>
        {channel.encrypted && <EncryptedChannelBadge />}
        {channel.isPrivate && <Lock className="h-3 w-3 shrink-0 text-default-400" />}
        {channel.isReadOnly && <Megaphone className="h-3 w-3 shrink-0 text-default-400" />}
        {unreadCount > 0 && (
          <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-danger px-1 text-xs text-danger-foreground">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </Button>
      {canManageChannels && (
        <Dropdown>
          <DropdownTrigger>
            <Button
              variant="light"
              isIconOnly
              size="sm"
              className="h-6 w-6 min-w-0 opacity-0 group-hover:opacity-100"
              data-test="channel-settings-button"
            >
              <Settings className="h-3.5 w-3.5 text-default-400" />
            </Button>
          </DropdownTrigger>
          <DropdownMenu
            aria-label={t('channelOptions')}
            onAction={(key) => {
              if (key === 'edit') onEdit()
              if (key === 'delete') onDelete()
            }}
          >
            <DropdownItem key="edit" data-test="channel-edit-item">
              {t('editChannel')}
            </DropdownItem>
            <DropdownItem
              key="delete"
              className="text-danger"
              color="danger"
              data-test="channel-delete-item"
            >
              {t('deleteChannel')}
            </DropdownItem>
          </DropdownMenu>
        </Dropdown>
      )}
    </div>
  )
}

// WHY: Extracted to reduce ChannelSidebar cognitive complexity below Biome's limit of 15.
function ServerHeader({
  serverId,
  serverName,
  canAccessSettings,
  onInvite,
  onSettings,
  onCreateChannel,
  onLeave,
}: {
  serverId: string | null
  serverName: string | null
  canAccessSettings: boolean
  onInvite: () => void
  onSettings: () => void
  onCreateChannel: () => void
  onLeave: () => void
}) {
  const { t } = useTranslation('channels')

  if (serverId === null) {
    return (
      <div className="flex h-full flex-1 items-center px-4">
        <span className="font-semibold text-foreground">{t('home')}</span>
      </div>
    )
  }

  return (
    <Dropdown>
      <DropdownTrigger>
        <button
          data-test="server-header-button"
          type="button"
          className="flex h-full flex-1 items-center justify-between px-4 font-semibold text-foreground transition-colors hover:bg-default-200"
        >
          <span data-test="server-name-header" className="truncate">
            {serverName ?? t('selectServer')}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-default-500" />
        </button>
      </DropdownTrigger>
      <DropdownMenu
        aria-label={t('serverOptions')}
        data-test="server-dropdown-menu"
        className="w-56"
        onAction={(key) => {
          if (key === 'invite') onInvite()
          if (key === 'settings' && canAccessSettings) onSettings()
          if (key === 'create-channel' && canAccessSettings) onCreateChannel()
          if (key === 'leave') onLeave()
        }}
      >
        <DropdownSection showDivider>
          <DropdownItem key="boost">{t('serverBoost')}</DropdownItem>
        </DropdownSection>
        <DropdownSection showDivider>
          <DropdownItem
            key="invite"
            startContent={<UserPlus className="h-4 w-4" />}
            data-test="server-menu-invite-item"
          >
            {t('servers:invitePeople')}
          </DropdownItem>
          <DropdownItem
            key="settings"
            className={canAccessSettings ? '' : 'hidden'}
            data-test="server-menu-settings-item"
          >
            {t('serverSettings')}
          </DropdownItem>
          <DropdownItem
            key="create-channel"
            className={canAccessSettings ? '' : 'hidden'}
            data-test="server-menu-create-channel-item"
          >
            {t('createChannel')}
          </DropdownItem>
        </DropdownSection>
        <DropdownSection>
          <DropdownItem
            key="leave"
            className="text-danger"
            color="danger"
            data-test="server-menu-leave-item"
          >
            {t('leaveServer')}
          </DropdownItem>
        </DropdownSection>
      </DropdownMenu>
    </Dropdown>
  )
}

// WHY: Extracted to reduce ChannelSidebar cognitive complexity below Biome's limit of 15.
function UserControlPanel() {
  const { t } = useTranslation('channels')
  const { t: tVoice } = useTranslation('voice')
  const user = useAuthStore((s) => s.user)
  const { data: profile } = useCurrentProfile()
  const status = useUserStatus(user?.id ?? '')
  const username = profile?.username ?? t('youFallback')
  const isMuted = useVoiceConnectionStore((s) => s.isMuted)
  const isDeafened = useVoiceConnectionStore((s) => s.isDeafened)
  const toggleMute = useVoiceConnectionStore((s) => s.toggleMute)
  const toggleDeafen = useVoiceConnectionStore((s) => s.toggleDeafen)

  const statusLabels = {
    online: t('statusOnline'),
    idle: t('statusIdle'),
    dnd: t('statusDnd'),
    offline: t('statusOffline'),
  } as const

  return (
    <div
      data-test="user-control-panel"
      className="flex items-center border-t border-divider bg-content1"
    >
      <StatusPicker>
        <div className="relative">
          <Avatar
            name={username}
            size="sm"
            color="primary"
            showFallback
            classNames={{
              base: 'h-8 w-8',
              name: 'text-xs text-primary-foreground',
            }}
          />
          <div className="absolute -bottom-0.5 -right-0.5">
            <StatusIndicator status={status} size="lg" />
          </div>
        </div>
        <div className="flex flex-1 flex-col overflow-hidden">
          <span className="truncate text-sm font-medium text-foreground">{username}</span>
          <span className="truncate text-xs text-default-500">{statusLabels[status]}</span>
        </div>
      </StatusPicker>
      <div className="flex items-center pr-2">
        <Tooltip content={isMuted ? tVoice('unmute') : tVoice('mute')} placement="top" delay={300}>
          <Button
            variant="light"
            isIconOnly
            size="sm"
            className="h-8 w-8"
            onPress={toggleMute}
            data-test="voice-mute-btn"
          >
            {isMuted ? (
              <MicOff className="h-4 w-4 text-danger" />
            ) : (
              <Mic className="h-4 w-4 text-default-500" />
            )}
          </Button>
        </Tooltip>
        <Tooltip
          content={isDeafened ? tVoice('undeafen') : tVoice('deafen')}
          placement="top"
          delay={300}
        >
          <Button
            variant="light"
            isIconOnly
            size="sm"
            className="h-8 w-8"
            onPress={toggleDeafen}
            data-test="voice-deafen-btn"
          >
            {isDeafened ? (
              <HeadphoneOff className="h-4 w-4 text-danger" />
            ) : (
              <Headphones className="h-4 w-4 text-default-500" />
            )}
          </Button>
        </Tooltip>
        <Button variant="light" isIconOnly size="sm" className="h-8 w-8">
          <Settings className="h-4 w-4 text-default-500" />
        </Button>
      </div>
    </div>
  )
}

interface ChannelSidebarProps {
  serverId: string | null
  serverName: string | null
  selectedChannelId: string | null
  onSelectChannel: (channelId: string) => void
  joinVoice: (channelId: string, serverId: string) => void
}

export function ChannelSidebar({
  serverId,
  serverName,
  selectedChannelId,
  onSelectChannel,
  joinVoice,
}: ChannelSidebarProps) {
  const { t } = useTranslation('channels')
  const { data: channels, isPending, isError, refetch, isRefetching } = useChannels(serverId)
  const [isInviteOpen, setIsInviteOpen] = useState(false)
  const [isCreateChannelOpen, setIsCreateChannelOpen] = useState(false)
  const [editChannel, setEditChannel] = useState<ChannelResponse | null>(null)
  const deleteChannelMutation = useDeleteChannel(serverId ?? '')
  const leaveServerMutation = useLeaveServer()
  const openServerSettings = useSettingsUiStore((s) => s.openServerSettings)
  const { role: callerRole } = useMyMemberRole(serverId)
  /** WHY: Only admin+ can access server settings. */
  const canAccessSettings = ROLE_HIERARCHY[callerRole] >= ROLE_HIERARCHY.admin
  const voiceChannelId = useVoiceConnectionStore((s) => s.currentChannelId)

  return (
    <div data-test="channel-sidebar" className="flex h-full flex-col bg-default-100">
      {/* Server header */}
      <div className="flex h-12 items-center border-b border-divider shadow-sm">
        <ServerHeader
          serverId={serverId}
          serverName={serverName}
          canAccessSettings={canAccessSettings}
          onInvite={() => setIsInviteOpen(true)}
          onSettings={openServerSettings}
          onCreateChannel={() => setIsCreateChannelOpen(true)}
          onLeave={() => {
            if (serverId === null) return
            if (window.confirm(t('leaveConfirm', { serverName: serverName ?? '' }))) {
              leaveServerMutation.mutate(serverId)
            }
          }}
        />
      </div>

      {/* Channel list */}
      <div data-test="channel-list" className="flex-1 overflow-y-auto px-2">
        <div className="py-3">
          {isPending && serverId !== null && (
            <div className="flex justify-center py-4">
              <Spinner size="sm" />
            </div>
          )}

          {isError && channels === undefined && (
            <ErrorState
              icon={<Hash className="h-8 w-8" />}
              message={t('failedToLoadChannels')}
              onRetry={() => refetch()}
              isRetrying={isRefetching}
            />
          )}

          {serverId === null && (
            <div className="flex flex-col items-center gap-2 px-4 py-8">
              <Hash className="h-8 w-8 text-default-300" />
              <p className="text-center text-xs text-default-500">{t('selectServerHint')}</p>
            </div>
          )}

          {channels !== undefined && channels.length === 0 && (
            <p className="px-2 text-xs text-default-500">{t('noChannelsYet')}</p>
          )}

          {channels !== undefined && channels.length > 0 && (
            <div className={isError ? 'opacity-70' : undefined}>
              {channels.map((channel) => (
                <div key={channel.id}>
                  <ChannelButton
                    channel={channel}
                    isActive={
                      channel.channelType === 'voice'
                        ? voiceChannelId === channel.id
                        : channel.id === selectedChannelId
                    }
                    canManageChannels={canAccessSettings}
                    onSelect={() => {
                      if (channel.channelType === 'voice' && serverId !== null) {
                        if (voiceChannelId !== channel.id) {
                          void joinVoice(channel.id, serverId)
                        }
                      } else {
                        onSelectChannel(channel.id)
                      }
                    }}
                    onEdit={() => setEditChannel(channel)}
                    onDelete={() => {
                      if (window.confirm(t('deleteConfirm', { channelName: channel.name }))) {
                        deleteChannelMutation.mutate(channel.id)
                      }
                    }}
                  />
                  {channel.channelType === 'voice' && (
                    <VoiceParticipantList channelId={channel.id} />
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Voice connection bar — shows status/disconnect when in voice */}
      <VoiceConnectionBar
        channelName={channels?.find((c) => c.id === voiceChannelId)?.name ?? null}
        onRetry={() => {
          if (voiceChannelId !== null && serverId !== null) {
            void joinVoice(voiceChannelId, serverId)
          }
        }}
      />
      <AudioAutoplayPrompt />

      <UserControlPanel />

      {serverId !== null && (
        <CreateInviteDialog
          serverId={serverId}
          isOpen={isInviteOpen}
          onClose={() => setIsInviteOpen(false)}
        />
      )}

      {serverId !== null && (
        <CreateChannelDialog
          serverId={serverId}
          isOpen={isCreateChannelOpen}
          onClose={() => setIsCreateChannelOpen(false)}
        />
      )}

      {editChannel !== null && serverId !== null && (
        <EditChannelDialog
          channel={editChannel}
          serverId={serverId}
          isOpen
          onClose={() => setEditChannel(null)}
        />
      )}
    </div>
  )
}
