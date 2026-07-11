import { Avatar, Button, Chip, Input, Spinner } from '@heroui/react'
import { Compass, Plus, Search, Users, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ErrorState } from '@/components/shared/error-state'
import { useServers } from '@/features/server-nav'
import type { DiscoveryServerResponse } from '@/lib/api'
import { useDiscoveryUiStore } from '@/lib/discovery-ui-store'
import { cn } from '@/lib/utils'
import { useDebouncedValue } from './hooks/use-debounced-value'
import { useDiscoveryServers } from './hooks/use-discovery-servers'
import { useJoinDiscoveryServer } from './hooks/use-join-discovery-server'

/**
 * Directory categories — MUST mirror the API allowlist
 * (harmony-api `DISCOVERY_CATEGORIES`). Labels come from the i18n map.
 */
export const DISCOVERY_CATEGORIES = [
  'gaming',
  'tech',
  'education',
  'music',
  'art',
  'science',
  'community',
  'other',
] as const

/** Quiet time before a typed search hits the API. */
const SEARCH_DEBOUNCE_MS = 300

interface DiscoveryPageProps {
  /** Navigate into a server after a successful join (or an "Open" click). */
  onJoined: (serverId: string) => void
  /** Open the create-server flow from the empty state. */
  onCreateServer: () => void
}

function serverInitials(name: string): string {
  return name
    .split(' ')
    .filter((w) => w.length > 0)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
}

function ServerCard({
  server,
  isMember,
  isJoining,
  onJoin,
  onOpen,
}: {
  server: DiscoveryServerResponse
  isMember: boolean
  isJoining: boolean
  onJoin: () => void
  onOpen: () => void
}) {
  const { t } = useTranslation('discovery')

  return (
    <div
      data-test="discovery-server-card"
      data-server-id={server.id}
      className="flex flex-col gap-3 rounded-xl border border-divider bg-content1 p-4"
    >
      <div className="flex items-center gap-3">
        <Avatar
          name={serverInitials(server.name)}
          src={server.iconUrl ?? undefined}
          classNames={{ base: 'h-12 w-12 shrink-0 rounded-2xl' }}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold text-foreground">{server.name}</p>
          <p className="flex items-center gap-1 text-xs text-default-500">
            <Users className="h-3 w-3" />
            {t('memberCount', { count: server.memberCount })}
          </p>
        </div>
        {server.category !== null && server.category !== undefined && (
          <Chip size="sm" variant="flat" color="secondary">
            {t(`category.${server.category}`)}
          </Chip>
        )}
      </div>

      {server.description !== null && server.description !== undefined && (
        <p className="line-clamp-3 text-sm text-default-600">{server.description}</p>
      )}

      <div className="mt-auto">
        {isMember ? (
          <Button
            size="sm"
            variant="flat"
            fullWidth
            onPress={onOpen}
            data-test="discovery-open-button"
          >
            {t('open')}
          </Button>
        ) : (
          <Button
            size="sm"
            color="primary"
            fullWidth
            isLoading={isJoining}
            onPress={onJoin}
            data-test="discovery-join-button"
          >
            {t('join')}
          </Button>
        )}
      </div>
    </div>
  )
}

function EmptyState({
  hasFilters,
  onCreateServer,
}: {
  hasFilters: boolean
  onCreateServer: () => void
}) {
  const { t } = useTranslation('discovery')

  return (
    <div
      data-test="discovery-empty-state"
      className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center"
    >
      <Compass className="h-12 w-12 text-default-300" />
      <p className="text-lg font-semibold text-foreground">
        {hasFilters ? t('emptyFilteredTitle') : t('emptyTitle')}
      </p>
      <p className="max-w-sm text-sm text-default-500">{t('emptySubtitle')}</p>
      <Button
        color="primary"
        startContent={<Plus className="h-4 w-4" />}
        onPress={onCreateServer}
        data-test="discovery-create-server-button"
      >
        {t('createYourOwn')}
      </Button>
    </div>
  )
}

export function DiscoveryPage({ onJoined, onCreateServer }: DiscoveryPageProps) {
  const { t } = useTranslation('discovery')
  const closeDiscovery = useDiscoveryUiStore((s) => s.closeDiscovery)
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState<string | null>(null)
  const debouncedSearch = useDebouncedValue(search.trim(), SEARCH_DEBOUNCE_MS)

  const {
    data,
    isPending,
    isError,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    refetch,
    isRefetching,
  } = useDiscoveryServers(debouncedSearch, category)
  const joinServer = useJoinDiscoveryServer()
  // WHY: Existing memberships flip the CTA to "Open" — joining is an
  // idempotent no-op server-side, but navigating directly is the honest UX.
  const { data: myServers } = useServers()
  const myServerIds = new Set(myServers?.map((s) => s.id) ?? [])

  const items = data?.pages.flatMap((page) => page.items) ?? []
  const hasFilters = debouncedSearch !== '' || category !== null
  // WHY derived (not inline negations): explicit status derivation keeps the
  // render conditions readable and satisfies the boolean-state arch rule.
  const isSettled = isPending === false && isError === false
  const showEmpty = isSettled && items.length === 0
  const showResults = isSettled && items.length > 0

  function handleJoin(serverId: string) {
    joinServer.mutate(serverId, {
      onSuccess: (joinedId) => {
        onJoined(joinedId)
      },
    })
  }

  return (
    <div data-test="discovery-page" className="flex h-full flex-1 flex-col bg-background">
      {/* Header */}
      <div className="flex h-12 items-center justify-between border-b border-divider px-6">
        <h1 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Compass className="h-4 w-4" />
          {t('title')}
        </h1>
        <Button
          variant="light"
          isIconOnly
          size="sm"
          onPress={closeDiscovery}
          aria-label={t('close')}
          data-test="discovery-close-button"
        >
          <X className="h-5 w-5 text-default-500" />
        </Button>
      </div>

      <div className="flex flex-1 flex-col overflow-y-auto p-6">
        <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-4">
          <div>
            <h2 className="text-xl font-semibold text-foreground">{t('heading')}</h2>
            <p className="mt-1 text-sm text-default-500">{t('subtitle')}</p>
          </div>

          {/* Search */}
          <Input
            value={search}
            onValueChange={setSearch}
            placeholder={t('searchPlaceholder')}
            startContent={<Search className="h-4 w-4 text-default-400" />}
            isClearable
            onClear={() => setSearch('')}
            data-test="discovery-search-input"
          />

          {/* Category chips */}
          <div className="flex flex-wrap gap-2" data-test="discovery-category-chips">
            <Chip
              as="button"
              variant={category === null ? 'solid' : 'flat'}
              color={category === null ? 'primary' : 'default'}
              onClick={() => setCategory(null)}
              data-test="discovery-category-all"
            >
              {t('category.all')}
            </Chip>
            {DISCOVERY_CATEGORIES.map((c) => (
              <Chip
                key={c}
                as="button"
                variant={category === c ? 'solid' : 'flat'}
                color={category === c ? 'primary' : 'default'}
                onClick={() => setCategory(category === c ? null : c)}
                data-test={`discovery-category-${c}`}
              >
                {t(`category.${c}`)}
              </Chip>
            ))}
          </div>

          {/* Results */}
          {isPending && (
            <div className="flex flex-1 items-center justify-center py-16">
              <Spinner size="lg" data-test="discovery-loading" />
            </div>
          )}

          {isError && (
            <div className="flex flex-1 items-center justify-center py-16">
              <ErrorState
                icon={<Compass className="h-12 w-12" />}
                message={t('loadFailed')}
                onRetry={() => {
                  void refetch()
                }}
                isRetrying={isRefetching}
              />
            </div>
          )}

          {showEmpty && <EmptyState hasFilters={hasFilters} onCreateServer={onCreateServer} />}

          {showResults && (
            <>
              <div className={cn('grid gap-4', 'sm:grid-cols-2 lg:grid-cols-3')}>
                {items.map((server) => (
                  <ServerCard
                    key={server.id}
                    server={server}
                    isMember={myServerIds.has(server.id)}
                    isJoining={joinServer.isPending && joinServer.variables === server.id}
                    onJoin={() => handleJoin(server.id)}
                    onOpen={() => onJoined(server.id)}
                  />
                ))}
              </div>
              {hasNextPage === true && (
                <Button
                  variant="flat"
                  className="mx-auto"
                  isLoading={isFetchingNextPage}
                  onPress={() => {
                    void fetchNextPage()
                  }}
                  data-test="discovery-load-more-button"
                >
                  {t('loadMore')}
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
