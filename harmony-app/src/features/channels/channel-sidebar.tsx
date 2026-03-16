import {
  Avatar,
  Button,
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownSection,
  DropdownTrigger,
  Spinner,
} from '@heroui/react'
import { ChevronDown, Hash, Headphones, Mic, Settings, UserPlus, Volume2 } from 'lucide-react'
import { useState } from 'react'
import { useAuthStore } from '@/features/auth'
import { StatusIndicator, useUserStatus } from '@/features/presence'
import { CreateInviteDialog } from '@/features/server-nav'
import type { ChannelResponse } from '@/lib/api'
import { cn } from '@/lib/utils'
import { CreateChannelDialog } from './create-channel-dialog'
import { EditChannelDialog } from './edit-channel-dialog'
import { useChannels } from './hooks/use-channels'
import { useDeleteChannel } from './hooks/use-delete-channel'

function ChannelButton({
  channel,
  isActive,
  onSelect,
  onEdit,
  onDelete,
}: {
  channel: ChannelResponse
  isActive: boolean
  onSelect: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  return (
    <div className="group flex items-center">
      <Button
        data-test="channel-button"
        data-channel-id={channel.id}
        variant="light"
        size="sm"
        onPress={onSelect}
        className={cn(
          'flex-1 justify-start gap-1.5 px-2 font-medium text-default-500',
          isActive && 'bg-default-200 text-foreground',
        )}
      >
        {channel.channelType === 'text' ? (
          <Hash className="h-4 w-4 shrink-0 text-default-500" />
        ) : (
          <Volume2 className="h-4 w-4 shrink-0 text-default-500" />
        )}
        <span className="truncate">{channel.name}</span>
      </Button>
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
          aria-label="Channel options"
          onAction={(key) => {
            if (key === 'edit') onEdit()
            if (key === 'delete') onDelete()
          }}
        >
          <DropdownItem key="edit" data-test="channel-edit-item">
            Edit Channel
          </DropdownItem>
          <DropdownItem
            key="delete"
            className="text-danger"
            color="danger"
            data-test="channel-delete-item"
          >
            Delete Channel
          </DropdownItem>
        </DropdownMenu>
      </Dropdown>
    </div>
  )
}

interface ChannelSidebarProps {
  serverId: string | null
  serverName: string | null
  selectedChannelId: string | null
  onSelectChannel: (channelId: string) => void
}

export function ChannelSidebar({
  serverId,
  serverName,
  selectedChannelId,
  onSelectChannel,
}: ChannelSidebarProps) {
  const { data: channels, isPending, isError } = useChannels(serverId)
  const [isInviteOpen, setIsInviteOpen] = useState(false)
  const [isCreateChannelOpen, setIsCreateChannelOpen] = useState(false)
  const [editChannel, setEditChannel] = useState<ChannelResponse | null>(null)
  const deleteChannelMutation = useDeleteChannel(serverId ?? '')
  const user = useAuthStore((s) => s.user)
  const status = useUserStatus(user?.id ?? '')
  const username =
    (typeof user?.user_metadata?.username === 'string' ? user.user_metadata.username : undefined) ??
    (typeof user?.user_metadata?.display_name === 'string'
      ? user.user_metadata.display_name
      : undefined) ??
    user?.email?.split('@')[0] ??
    'You'

  return (
    <div data-test="channel-sidebar" className="flex h-full flex-col bg-default-100">
      {/* Server header */}
      <div className="flex h-12 items-center border-b border-divider shadow-sm">
        <Dropdown>
          <DropdownTrigger>
            <button
              type="button"
              className="flex h-full flex-1 items-center justify-between px-4 font-semibold text-foreground transition-colors hover:bg-default-200"
            >
              <span data-test="server-name-header" className="truncate">
                {serverName ?? 'Select a server'}
              </span>
              <ChevronDown className="h-4 w-4 shrink-0 text-default-500" />
            </button>
          </DropdownTrigger>
          <DropdownMenu
            aria-label="Server options"
            className="w-56"
            onAction={(key) => {
              if (key === 'invite' && serverId !== null) {
                setIsInviteOpen(true)
              }
              if (key === 'create-channel') {
                setIsCreateChannelOpen(true)
              }
            }}
          >
            <DropdownSection showDivider>
              <DropdownItem key="boost">Server Boost</DropdownItem>
            </DropdownSection>
            <DropdownSection showDivider>
              <DropdownItem
                key="invite"
                startContent={<UserPlus className="h-4 w-4" />}
                data-test="server-menu-invite-item"
              >
                Invite People
              </DropdownItem>
              <DropdownItem key="settings">Server Settings</DropdownItem>
              <DropdownItem key="create-channel" data-test="server-menu-create-channel-item">
                Create Channel
              </DropdownItem>
            </DropdownSection>
            <DropdownSection>
              <DropdownItem key="leave" className="text-danger" color="danger">
                Leave Server
              </DropdownItem>
            </DropdownSection>
          </DropdownMenu>
        </Dropdown>
      </div>

      {/* Channel list */}
      <div className="flex-1 overflow-y-auto px-2">
        <div className="py-3">
          {isPending && serverId !== null && (
            <div className="flex justify-center py-4">
              <Spinner size="sm" />
            </div>
          )}

          {isError && <p className="px-2 text-xs text-danger">Failed to load channels</p>}

          {serverId === null && (
            <p className="px-2 text-xs text-default-500">Select a server to view channels</p>
          )}

          {channels !== undefined && channels.length === 0 && (
            <p className="px-2 text-xs text-default-500">No channels yet</p>
          )}

          {channels?.map((channel) => (
            <ChannelButton
              key={channel.id}
              channel={channel}
              isActive={channel.id === selectedChannelId}
              onSelect={() => onSelectChannel(channel.id)}
              onEdit={() => setEditChannel(channel)}
              onDelete={() => {
                if (window.confirm(`Delete #${channel.name}? This cannot be undone.`)) {
                  deleteChannelMutation.mutate(channel.id)
                }
              }}
            />
          ))}
        </div>
      </div>

      {/* User control panel */}
      <div className="flex items-center gap-2 border-t border-divider bg-content1 p-2">
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
          <span className="truncate text-xs text-default-500">
            {status === 'dnd' ? 'Do Not Disturb' : status.charAt(0).toUpperCase() + status.slice(1)}
          </span>
        </div>
        <div className="flex items-center">
          <Button variant="light" isIconOnly size="sm" className="h-8 w-8">
            <Mic className="h-4 w-4 text-default-500" />
          </Button>
          <Button variant="light" isIconOnly size="sm" className="h-8 w-8">
            <Headphones className="h-4 w-4 text-default-500" />
          </Button>
          <Button variant="light" isIconOnly size="sm" className="h-8 w-8">
            <Settings className="h-4 w-4 text-default-500" />
          </Button>
        </div>
      </div>

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
