import { Spinner, Tab, Tabs } from '@heroui/react'
import { UserRound } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ErrorState } from '@/components/shared/error-state'
import { usePresenceStore } from '@/features/presence'
import { useBlocks } from '../hooks/use-blocks'
import { useFriendRequests } from '../hooks/use-friend-requests'
import { useFriends } from '../hooks/use-friends'
import { AddFriendBar } from './add-friend-bar'
import { BlockedListItem } from './blocked-list-item'
import { FriendListItem } from './friend-list-item'
import { RequestListItem } from './request-list-item'

interface FriendsPanelProps {
  onNavigateDm: (serverId: string, channelId: string) => void
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center gap-2 py-12 text-center">
      <UserRound className="h-10 w-10 text-default-300" />
      <p className="text-sm text-default-500">{message}</p>
    </div>
  )
}

export function FriendsPanel({ onNavigateDm }: FriendsPanelProps) {
  const { t } = useTranslation('friends')
  const friends = useFriends()
  const incoming = useFriendRequests('incoming')
  const outgoing = useFriendRequests('outgoing')
  const blocks = useBlocks()
  const presenceMap = usePresenceStore((s) => s.presenceMap)

  const onlineFriends = (friends.data ?? []).filter((f) => {
    const status = presenceMap.get(f.user.id)
    return status !== undefined && status !== 'offline'
  })

  const incomingCount = incoming.data?.length ?? 0

  return (
    <div data-test="friends-panel" className="flex h-full flex-col bg-content1">
      <div className="border-b border-divider px-4 py-3">
        <AddFriendBar />
      </div>

      <Tabs
        aria-label={t('friends')}
        variant="underlined"
        classNames={{ base: 'px-4 pt-2', panel: 'flex-1 overflow-y-auto px-2 pb-4' }}
      >
        <Tab key="online" title={t('tabOnline')} data-test="friends-tab-online">
          {friends.isPending ? (
            <div className="flex justify-center py-8">
              <Spinner size="sm" />
            </div>
          ) : friends.isError ? (
            <ErrorState
              icon={<UserRound className="h-10 w-10" />}
              message={t('failedToLoad')}
              onRetry={() => friends.refetch()}
            />
          ) : onlineFriends.length === 0 ? (
            <EmptyState message={t('emptyOnline')} />
          ) : (
            onlineFriends.map((f) => (
              <FriendListItem key={f.user.id} friend={f} onNavigateDm={onNavigateDm} />
            ))
          )}
        </Tab>

        <Tab key="all" title={t('tabAll')} data-test="friends-tab-all">
          {friends.isPending ? (
            <div className="flex justify-center py-8">
              <Spinner size="sm" />
            </div>
          ) : friends.isError ? (
            <ErrorState
              icon={<UserRound className="h-10 w-10" />}
              message={t('failedToLoad')}
              onRetry={() => friends.refetch()}
            />
          ) : (friends.data?.length ?? 0) === 0 ? (
            <EmptyState message={t('emptyAll')} />
          ) : (
            friends.data?.map((f) => (
              <FriendListItem key={f.user.id} friend={f} onNavigateDm={onNavigateDm} />
            ))
          )}
        </Tab>

        <Tab
          key="pending"
          data-test="friends-tab-pending"
          title={
            <div className="flex items-center gap-1.5">
              <span>{t('tabPending')}</span>
              {incomingCount > 0 && (
                <span
                  role="status"
                  aria-label={t('pendingBadgeLabel', { count: incomingCount })}
                  className="flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] text-danger-foreground"
                >
                  {incomingCount > 99 ? '99+' : incomingCount}
                </span>
              )}
            </div>
          }
        >
          {incoming.isPending || outgoing.isPending ? (
            <div className="flex justify-center py-8">
              <Spinner size="sm" />
            </div>
          ) : incoming.isError || outgoing.isError ? (
            <ErrorState
              icon={<UserRound className="h-10 w-10" />}
              message={t('failedToLoad')}
              onRetry={() => {
                incoming.refetch()
                outgoing.refetch()
              }}
            />
          ) : incomingCount === 0 && (outgoing.data?.length ?? 0) === 0 ? (
            <EmptyState message={t('emptyPending')} />
          ) : (
            <>
              {incomingCount > 0 && (
                <section className="mb-2">
                  <p className="px-2 py-1 text-xs font-semibold uppercase text-default-500">
                    {t('incoming')}
                  </p>
                  {incoming.data?.map((r) => (
                    <RequestListItem key={r.user.id} request={r} />
                  ))}
                </section>
              )}
              {(outgoing.data?.length ?? 0) > 0 && (
                <section>
                  <p className="px-2 py-1 text-xs font-semibold uppercase text-default-500">
                    {t('outgoing')}
                  </p>
                  {outgoing.data?.map((r) => (
                    <RequestListItem key={r.user.id} request={r} />
                  ))}
                </section>
              )}
            </>
          )}
        </Tab>

        <Tab key="blocked" title={t('tabBlocked')} data-test="friends-tab-blocked">
          {blocks.isPending ? (
            <div className="flex justify-center py-8">
              <Spinner size="sm" />
            </div>
          ) : blocks.isError ? (
            <ErrorState
              icon={<UserRound className="h-10 w-10" />}
              message={t('failedToLoad')}
              onRetry={() => blocks.refetch()}
            />
          ) : (blocks.data?.length ?? 0) === 0 ? (
            <EmptyState message={t('emptyBlocked')} />
          ) : (
            blocks.data?.map((b) => <BlockedListItem key={b.user.id} blocked={b} />)
          )}
        </Tab>
      </Tabs>
    </div>
  )
}
