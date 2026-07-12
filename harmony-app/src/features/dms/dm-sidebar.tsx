import { Avatar, Button, Spinner } from '@heroui/react'
import { Lock, MessageSquarePlus, Users, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ErrorState } from '@/components/shared/error-state'
import { useUnreadStore } from '@/features/channels'
import { useFriendRequests } from '@/features/friends'
import { StatusIndicator, useUserStatus } from '@/features/presence'
import { ProfilePopover } from '@/features/profiles'
import { UserControlPanel } from '@/features/user-panel'
import type { DmListItem } from '@/lib/api'
import { resolveDisplayName } from '@/lib/display-name'
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
  const displayName = resolveDisplayName(dm.recipient)
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
        {/* WHY stopPropagation: the avatar opens the profile card; the rest of
            the row still navigates to the DM (the row is a button). */}
        <ProfilePopover userId={dm.recipient.id} serverId={null}>
          {/* biome-ignore lint/a11y/useSemanticElements: HeroUI PopoverTrigger adds pressable/keyboard/aria semantics at runtime */}
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: onClick only stops row-nav bubbling; PopoverTrigger owns keyboard */}
          <div
            role="button"
            tabIndex={0}
            onClick={(e) => e.stopPropagation()}
            className="relative shrink-0 cursor-pointer"
            data-test="dm-recipient-avatar"
          >
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
        </ProfilePopover>
        <div className="flex flex-1 flex-col overflow-hidden">
          <span
            className={cn(
              'truncate text-sm text-foreground',
              unreadCount > 0 && !isActive ? 'font-semibold' : 'font-medium',
            )}
          >
            {displayName}
          </span>
          {dm.lastMessage !== undefined && dm.lastMessage !== null && (
            <span className="truncate text-xs text-default-500">
              {dm.lastMessage.encrypted === true ? (
                <span className="inline-flex items-center gap-1 italic">
                  <Lock className="h-3 w-3" />
                  {t('encryptedPreview')}
                </span>
              ) : dm.lastMessage.content.length > 50 ? (
                `${dm.lastMessage.content.slice(0, 50)}...`
              ) : (
                dm.lastMessage.content
              )}
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
  onSelectFriends: () => void
}

export function DmSidebar({ selectedServerId, onSelectDm, onSelectFriends }: DmSidebarProps) {
  const { t } = useTranslation('dms')
  const { t: tFriends } = useTranslation('friends')
  const incomingRequests = useFriendRequests('incoming')
  const pendingCount = incomingRequests.data?.length ?? 0
  const { data: dms, isPending, isError, refetch, isRefetching } = useDms()
  const closeDmMutation = useCloseDm()
  const [isSearchOpen, setIsSearchOpen] = useState(false)

  return (
    <div data-test="dm-sidebar" className="flex h-full flex-col bg-default-100">
      {/* Header */}
      <div className="flex h-12 items-center justify-between border-b border-divider px-4 shadow-sm">
        <span className="font-semibold text-foreground">{t('directMessages')}</span>
      </div>

      {/* Friends home nav — active when no conversation is selected */}
      <div className="px-2 pt-3 pb-1">
        <Button
          data-test="dm-friends-nav"
          variant={selectedServerId === null ? 'flat' : 'light'}
          size="sm"
          className="w-full justify-start gap-2"
          startContent={<Users className="h-4 w-4" />}
          onPress={onSelectFriends}
        >
          <span className="flex-1 text-left">{tFriends('friendsNav')}</span>
          {pendingCount > 0 && (
            <span
              role="status"
              aria-label={tFriends('pendingBadgeLabel', { count: pendingCount })}
              className="flex h-5 min-w-5 items-center justify-center rounded-full bg-danger px-1 text-xs text-danger-foreground"
            >
              {pendingCount > 99 ? '99+' : pendingCount}
            </span>
          )}
        </Button>
      </div>

      {/* New message button */}
      <div className="px-2 pb-1">
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
              <Button
                data-test="dm-empty-start-cta"
                size="sm"
                color="primary"
                variant="flat"
                className="mt-2"
                onPress={() => setIsSearchOpen(true)}
              >
                {t('startConversationCta')}
              </Button>
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

      <UserControlPanel />

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
