import { Avatar, Divider, Spinner, Tooltip } from '@heroui/react'
import { Compass, Info, LogOut, MessageSquare, Plus, Ticket } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useChannels, useUnreadStore } from '@/features/channels'
import { useDms } from '@/features/dms'
import { useFriendRequests } from '@/features/friends'
import { useAboutUiStore } from '@/lib/about-ui-store'
import type { ServerResponse } from '@/lib/api'
import { useDiscoveryUiStore } from '@/lib/discovery-ui-store'
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

/**
 * WHY: Sums mention counts across a server's channels. When > 0 the plain
 * unread dot is replaced by a count pill (spec §1: dot = unreads,
 * pill with number = mentions — no ambiguity).
 */
function useServerMentionCount(serverId: string): number {
  const { data: channels } = useChannels(serverId)
  const mentionCounts = useUnreadStore((s) => s.mentionCounts)
  if (channels === undefined) return 0
  return channels.reduce((sum, c) => sum + (mentionCounts[c.id] ?? 0), 0)
}

/**
 * WHY: Checks if any DM conversation has unread messages. Used to show
 * an unread dot on the DM home button when the user is in server view.
 */
function useDmsHaveUnread(): boolean {
  const { data: dms } = useDms()
  const counts = useUnreadStore((s) => s.counts)
  if (dms === undefined) return false
  return dms.some((dm) => (counts[dm.channelId] ?? 0) > 0)
}

/**
 * WHY: Sums mention counts across DM channels — every unread DM message is
 * mention-equivalent (spec §1 rule 2), which is what makes the DM home
 * button show a red count like Discord's.
 */
function useDmsMentionCount(): number {
  const { data: dms } = useDms()
  const mentionCounts = useUnreadStore((s) => s.mentionCounts)
  if (dms === undefined) return 0
  return dms.reduce((sum, dm) => sum + (mentionCounts[dm.channelId] ?? 0), 0)
}

/** Red count pill layered on a nav icon — shared by server icons and the DM home button. */
function MentionCountBadge({ count, testId }: { count: number; testId: string }) {
  return (
    <div
      data-test={testId}
      className="absolute -bottom-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full border-2 border-content1 bg-danger px-1 text-[10px] font-semibold text-danger-foreground"
    >
      {count > 99 ? '99+' : count}
    </div>
  )
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
  const mentionCount = useServerMentionCount(server.id)

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

        {/* Mention count pill replaces the plain dot when any channel has mentions (spec §1) */}
        {mentionCount > 0 && !isActive && (
          <MentionCountBadge count={mentionCount} testId="server-mention-badge" />
        )}

        {/* Unread dot — shows when any channel in this server has unread messages */}
        {mentionCount === 0 && hasUnread && !isActive && (
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
  const hasDmUnread = useDmsHaveUnread()
  const dmMentionCount = useDmsMentionCount()
  // Incoming friend requests badge on the DM home button (§5.4). Warm cache via
  // the eager mount in MainLayout — no new store.
  const incomingRequests = useFriendRequests('incoming')
  const pendingFriendCount = incomingRequests.data?.length ?? 0
  const dmHomeBadgeCount = dmMentionCount + pendingFriendCount

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

          {/* Mention count pill — unread DM messages (mention-equivalent, spec §1)
              plus incoming friend requests (§5.4). */}
          {dmHomeBadgeCount > 0 && !isDmView && (
            <MentionCountBadge count={dmHomeBadgeCount} testId="dm-mention-badge" />
          )}

          {/* Unread dot — shows when any DM has unread messages */}
          {dmMentionCount === 0 && hasDmUnread && !isDmView && (
            <div className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-content1 bg-danger" />
          )}
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

      {/* Discovery button — opens the public server directory */}
      <Tooltip content={t('discovery:title')} placement="right" offset={8}>
        <button
          type="button"
          data-test="discovery-button"
          onClick={() => useDiscoveryUiStore.getState().openDiscovery()}
          aria-label={t('discovery:title')}
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

      {/* Join server (via invite code) button */}
      <Tooltip content={t('joinServer')} placement="right" offset={8}>
        <button
          type="button"
          data-test="join-server-button"
          onClick={() => setIsJoinOpen(true)}
          aria-label={t('joinServer')}
          className="mt-2 flex items-center justify-center"
        >
          <Avatar
            icon={<Ticket className="h-5 w-5" />}
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
