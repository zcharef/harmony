import { Avatar, Button, Spinner } from '@heroui/react'
import { Headphones, MessageSquarePlus, Mic, Settings, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ErrorState } from '@/components/shared/error-state'
import { useAuthStore, useCurrentProfile } from '@/features/auth'
import { useUnreadStore } from '@/features/channels'
import { StatusIndicator, useUserStatus } from '@/features/presence'
import type { DmListItem } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useCloseDm } from './hooks/use-close-dm'
import { useDms } from './hooks/use-dms'
import { UserSearchDialog } from './user-search-dialog'

/**
 * WHY: Formats a timestamp into a relative human-readable string.
 * Kept simple: just now / Nm ago / Nh ago / Yesterday / Nd ago.
 */
function formatRelativeTime(
  isoTimestamp: string,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const now = Date.now()
  const then = new Date(isoTimestamp).getTime()
  const diffMs = now - then

  const MINUTE = 60_000
  const HOUR = 3_600_000
  const DAY = 86_400_000

  if (diffMs < MINUTE) return t('justNow')
  if (diffMs < HOUR) return t('minutesAgo', { count: Math.floor(diffMs / MINUTE) })
  if (diffMs < DAY) return t('hoursAgo', { count: Math.floor(diffMs / HOUR) })
  if (diffMs < DAY * 2) return t('yesterday')
  return t('daysAgo', { count: Math.floor(diffMs / DAY) })
}

function DmConversationItem({
  dm,
  isActive,
  onSelect,
  onClose,
}: {
  dm: DmListItem
  isActive: boolean
  onSelect: () => void
  onClose: () => void
}) {
  const { t } = useTranslation('dms')
  const displayName = dm.recipient.displayName ?? dm.recipient.username
  const status = useUserStatus(dm.recipient.id)
  const unreadCount = useUnreadStore((s) => s.counts[dm.channelId] ?? 0)

  return (
    <div
      className="group flex items-center"
      data-test="dm-conversation-row"
      data-dm-server-id={dm.serverId}
    >
      <button
        data-test="dm-conversation-item"
        data-dm-server-id={dm.serverId}
        type="button"
        onClick={onSelect}
        className={cn(
          'flex flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
          isActive ? 'bg-default-200' : 'hover:bg-default-200/50',
        )}
      >
        <div className="relative shrink-0">
          <Avatar
            name={displayName}
            src={dm.recipient.avatarUrl ?? undefined}
            size="sm"
            showFallback
            classNames={{ base: 'h-8 w-8', name: 'text-xs' }}
          />
          <div className="absolute -bottom-0.5 -right-0.5">
            <StatusIndicator status={status} size="sm" />
          </div>
        </div>
        <div className="flex flex-1 flex-col overflow-hidden">
          <span
            className={cn(
              'truncate text-sm text-foreground',
              unreadCount > 0 && !isActive ? 'font-semibold' : 'font-medium',
            )}
          >
            {displayName}
          </span>
          {/* TODO(e2ee): DmLastMessageResponse needs `encrypted` field from backend
             to show "[Encrypted message]" fallback on web. Without it, encrypted
             messages from desktop will show raw ciphertext in the sidebar. */}
          {dm.lastMessage !== undefined && dm.lastMessage !== null && (
            <span className="truncate text-xs text-default-500">
              {dm.lastMessage.content.length > 50
                ? `${dm.lastMessage.content.slice(0, 50)}...`
                : dm.lastMessage.content}
            </span>
          )}
        </div>
        {unreadCount > 0 ? (
          <span className="ml-auto flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-danger px-1 text-xs text-danger-foreground">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        ) : (
          dm.lastMessage !== undefined &&
          dm.lastMessage !== null && (
            <span className="shrink-0 text-[10px] text-default-400">
              {formatRelativeTime(dm.lastMessage.createdAt, t)}
            </span>
          )
        )}
      </button>
      <Button
        variant="light"
        isIconOnly
        size="sm"
        className="h-6 w-6 min-w-0 opacity-0 group-hover:opacity-100"
        onPress={onClose}
        data-test="dm-close-button"
      >
        <X className="h-3.5 w-3.5 text-default-400" />
      </Button>
    </div>
  )
}

interface DmSidebarProps {
  selectedServerId: string | null
  onSelectDm: (serverId: string, channelId: string) => void
}

export function DmSidebar({ selectedServerId, onSelectDm }: DmSidebarProps) {
  const { t } = useTranslation('dms')
  const { data: dms, isPending, isError, refetch, isRefetching } = useDms()
  const closeDmMutation = useCloseDm()
  const [isSearchOpen, setIsSearchOpen] = useState(false)
  const user = useAuthStore((s) => s.user)
  const { data: profile } = useCurrentProfile()
  const status = useUserStatus(user?.id ?? '')
  const username = profile?.username ?? t('you')

  const statusLabels = {
    online: t('statusOnline'),
    idle: t('statusIdle'),
    dnd: t('statusDnd'),
    offline: t('statusOffline'),
  } as const

  return (
    <div data-test="dm-sidebar" className="flex h-full flex-col bg-default-100">
      {/* Header */}
      <div className="flex h-12 items-center justify-between border-b border-divider px-4 shadow-sm">
        <span className="font-semibold text-foreground">{t('directMessages')}</span>
      </div>

      {/* New message button */}
      <div className="px-2 pt-3 pb-1">
        <Button
          data-test="dm-new-message-button"
          variant="flat"
          size="sm"
          className="w-full justify-start gap-2"
          startContent={<MessageSquarePlus className="h-4 w-4" />}
          onPress={() => setIsSearchOpen(true)}
        >
          {t('newMessage')}
        </Button>
      </div>

      {/* DM conversation list */}
      <div data-test="dm-list" className="flex-1 overflow-y-auto px-2">
        <div className="py-1">
          {isPending && (
            <div className="flex justify-center py-4">
              <Spinner size="sm" />
            </div>
          )}

          {isError && dms === undefined && (
            <ErrorState
              icon={<MessageSquarePlus className="h-10 w-10" />}
              message={t('failedToLoadDms')}
              onRetry={() => refetch()}
              isRetrying={isRefetching}
            />
          )}

          {dms !== undefined && dms.length === 0 && (
            <div className="flex flex-col items-center gap-2 px-2 py-8 text-center">
              <MessageSquarePlus className="h-10 w-10 text-default-300" />
              <p className="text-sm text-default-500">{t('noConversationsYet')}</p>
              <p className="text-xs text-default-400">{t('startConversation')}</p>
            </div>
          )}

          {dms !== undefined && dms.length > 0 && (
            <div className={isError ? 'opacity-70' : undefined}>
              {dms.map((dm) => (
                <DmConversationItem
                  key={dm.serverId}
                  dm={dm}
                  isActive={dm.serverId === selectedServerId}
                  onSelect={() => onSelectDm(dm.serverId, dm.channelId)}
                  onClose={() => closeDmMutation.mutate(dm.serverId)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* User control panel — matches ChannelSidebar pattern */}
      <div
        data-test="user-control-panel"
        className="flex items-center gap-2 border-t border-divider bg-content1 p-2"
      >
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

      <UserSearchDialog
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
        onDmCreated={(serverId, channelId) => {
          setIsSearchOpen(false)
          onSelectDm(serverId, channelId)
        }}
      />
    </div>
  )
}
