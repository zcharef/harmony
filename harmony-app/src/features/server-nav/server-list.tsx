import { Avatar, Divider, Spinner, Tooltip } from '@heroui/react'
import { Compass, Info, LogOut, MessageSquare, Plus } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useChannels, useUnreadStore } from '@/features/channels'
import { useAboutUiStore } from '@/lib/about-ui-store'
import type { ServerResponse } from '@/lib/api'
import { supabase } from '@/lib/supabase'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { CreateServerDialog } from './create-server-dialog'
import { useServers } from './hooks/use-servers'
import { JoinServerDialog } from './join-server-dialog'

/**
 * WHY: Checks if any channel in a server has unread messages by reading
 * both the channels list and the unread store. Returns true if any
 * channel's unread count is > 0.
 */
function useServerHasUnread(serverId: string): boolean {
  const { data: channels } = useChannels(serverId)
  const counts = useUnreadStore((s) => s.counts)
  if (channels === undefined) return false
  return channels.some((c) => (counts[c.id] ?? 0) > 0)
}

function ServerIcon({
  server,
  isActive,
  onSelect,
}: {
  server: ServerResponse
  isActive: boolean
  onSelect: () => void
}) {
  // WHY: Generate initials from server name for avatar fallback
  const initials = server.name
    .split(' ')
    .filter((w) => w.length > 0)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()

  const hasUnread = useServerHasUnread(server.id)

  return (
    <Tooltip content={server.name} placement="right" offset={8}>
      <button
        data-test="server-button"
        data-server-id={server.id}
        type="button"
        onClick={onSelect}
        className="relative flex w-full items-center justify-center group"
      >
        {/* Active pill indicator */}
        <div
          className={cn(
            'absolute left-0 w-1 rounded-r-full bg-foreground transition-all duration-200',
            isActive ? 'h-10' : 'h-0 group-hover:h-5',
          )}
        />

        <Avatar
          name={initials}
          src={server.iconUrl ?? undefined}
          classNames={{
            base: cn(
              'h-12 w-12 cursor-pointer transition-all duration-200',
              isActive
                ? 'rounded-2xl bg-primary text-primary-foreground'
                : 'rounded-[24px] hover:rounded-2xl bg-default-100 text-default-foreground hover:bg-primary hover:text-primary-foreground',
            ),
            name: cn(
              'text-sm font-medium transition-all duration-200',
              isActive
                ? 'text-primary-foreground'
                : 'text-default-foreground group-hover:text-primary-foreground',
            ),
          }}
        />

        {/* Unread dot — shows when any channel in this server has unread messages */}
        {hasUnread && !isActive && (
          <div className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-content1 bg-danger" />
        )}
      </button>
    </Tooltip>
  )
}

type ViewMode = 'servers' | 'dms'

interface ServerListProps {
  selectedServerId: string | null
  view: ViewMode
  onSelectServer: (serverId: string) => void
  onSelectDmView: () => void
}

export function ServerList({
  selectedServerId,
  view,
  onSelectServer,
  onSelectDmView,
}: ServerListProps) {
  const { t } = useTranslation('servers')
  const { t: tAuth } = useTranslation('auth')
  const { t: tDms } = useTranslation('dms')
  const { data: servers, isPending, isError } = useServers()
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [isJoinOpen, setIsJoinOpen] = useState(false)

  if (isPending) {
    return (
      <div className="flex h-full w-[72px] flex-col items-center justify-center bg-content1">
        <Spinner size="sm" />
      </div>
    )
  }

  if (isError) {
    return (
      <div className="flex h-full w-[72px] flex-col items-center justify-center bg-content1">
        <span className="text-xs text-danger">{t('common:error')}</span>
      </div>
    )
  }

  // WHY: Filter out DM servers — they appear in the DM sidebar, not as server icons
  const regularServers = servers?.filter((s) => !s.isDm) ?? []
  const isDmView = view === 'dms'

  return (
    <div
      data-test="server-list"
      className="flex h-full w-[72px] flex-col items-center bg-content1 py-3"
    >
      {/* Home / DMs icon */}
      <Tooltip content={tDms('home')} placement="right" offset={8}>
        <button
          data-test="dm-home-button"
          type="button"
          onClick={onSelectDmView}
          className="relative flex w-full items-center justify-center group"
        >
          {/* Active pill indicator */}
          <div
            className={cn(
              'absolute left-0 w-1 rounded-r-full bg-foreground transition-all duration-200',
              isDmView ? 'h-10' : 'h-0 group-hover:h-5',
            )}
          />

          <Avatar
            icon={<MessageSquare className="h-5 w-5" />}
            classNames={{
              base: cn(
                'h-12 w-12 cursor-pointer transition-all duration-200',
                isDmView
                  ? 'rounded-2xl bg-primary text-primary-foreground'
                  : 'rounded-[24px] hover:rounded-2xl bg-default-100 text-default-foreground hover:bg-primary hover:text-primary-foreground',
              ),
              icon: 'text-current',
            }}
          />
        </button>
      </Tooltip>

      <Divider className="mx-auto my-2 w-8 bg-divider" />

      {/* Server list */}
      <div className="w-full flex-1 overflow-y-auto">
        <div className="flex flex-col items-center gap-2">
          {regularServers.map((server) => (
            <ServerIcon
              key={server.id}
              server={server}
              isActive={view === 'servers' && server.id === selectedServerId}
              onSelect={() => onSelectServer(server.id)}
            />
          ))}
        </div>
      </div>

      <Divider className="mx-auto my-2 w-8 bg-divider" />

      {/* Add server button */}
      <Tooltip content={t('addServer')} placement="right" offset={8}>
        <button
          type="button"
          data-test="add-server-button"
          onClick={() => setIsCreateOpen(true)}
          aria-label={t('addServer')}
          className="flex items-center justify-center"
        >
          <Avatar
            icon={<Plus className="h-5 w-5" />}
            classNames={{
              base: cn(
                'h-12 w-12 cursor-pointer rounded-[24px] bg-default-100 text-default-foreground',
                'transition-all duration-200 hover:rounded-2xl hover:bg-success hover:text-success-foreground',
              ),
              icon: 'text-current',
            }}
          />
        </button>
      </Tooltip>

      {/* Join server button */}
      <Tooltip content={t('joinServer')} placement="right" offset={8}>
        <button
          type="button"
          data-test="join-server-button"
          onClick={() => setIsJoinOpen(true)}
          aria-label={t('joinServer')}
          className="mt-2 flex items-center justify-center"
        >
          <Avatar
            icon={<Compass className="h-5 w-5" />}
            classNames={{
              base: cn(
                'h-12 w-12 cursor-pointer rounded-[24px] bg-default-100 text-default-foreground',
                'transition-all duration-200 hover:rounded-2xl hover:bg-primary hover:text-primary-foreground',
              ),
              icon: 'text-current',
            }}
          />
        </button>
      </Tooltip>

      <Divider className="mx-auto my-2 w-8 bg-divider" />

      {/* About button */}
      <Tooltip content={t('common:about')} placement="right" offset={8}>
        <button
          type="button"
          data-test="about-button"
          onClick={() => useAboutUiStore.getState().openAboutPage()}
          aria-label={t('common:about')}
          className="mb-2 flex items-center justify-center"
        >
          <Avatar
            icon={<Info className="h-5 w-5" />}
            classNames={{
              base: cn(
                'h-12 w-12 cursor-pointer rounded-[24px] bg-default-100 text-default-foreground',
                'transition-all duration-200 hover:rounded-2xl hover:bg-primary hover:text-primary-foreground',
              ),
              icon: 'text-current',
            }}
          />
        </button>
      </Tooltip>

      {/* Logout button */}
      <Tooltip content={tAuth('logout')} placement="right" offset={8}>
        <button
          type="button"
          data-test="logout-button"
          onClick={() => {
            supabase.auth.signOut().catch((err: unknown) => {
              toast.error(tAuth('logoutFailed'), {
                context: { error: err instanceof Error ? err.message : String(err) },
              })
            })
          }}
          aria-label={tAuth('logout')}
          className="flex items-center justify-center"
        >
          <Avatar
            icon={<LogOut className="h-5 w-5" />}
            classNames={{
              base: cn(
                'h-12 w-12 cursor-pointer rounded-[24px] bg-default-100 text-default-foreground',
                'transition-all duration-200 hover:rounded-2xl hover:bg-danger hover:text-danger-foreground',
              ),
              icon: 'text-current',
            }}
          />
        </button>
      </Tooltip>

      <CreateServerDialog
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        onCreated={(serverId) => onSelectServer(serverId)}
      />

      <JoinServerDialog
        isOpen={isJoinOpen}
        onClose={() => setIsJoinOpen(false)}
        onJoined={(serverId) => onSelectServer(serverId)}
      />
    </div>
  )
}
