import {
  Button,
  Chip,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalHeader,
  Spinner,
} from '@heroui/react'
import { Lock, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ErrorState } from '@/components/shared/error-state'
import { useMembers } from '@/features/members'
import type { ChannelResponse, MemberResponse, MessageResponse } from '@/lib/api'
import { isProblemDetails } from '@/lib/api-error'
import { NAVIGATE_EVENT } from '@/lib/navigation-events'
import { type MessageSearchParams, useMessageSearch } from '../hooks/use-message-search'
import { parseSearchQuery } from '../lib/parse-search-query'
import { resolveSearchFilters } from '../lib/resolve-search-filters'
import { useSearchStore } from '../stores/search-store'
import { SearchResultsGroup } from './search-results-group'

const DEBOUNCE_MS = 250

// WHY a shared constant: a fresh `[]` fallback on every render would be a new
// reference and defeat the `resolveSearchFilters` memo below.
const EMPTY_MEMBERS: MemberResponse[] = []

/** Everything the overlay derives from the current input + scope. */
interface SearchPipeline {
  q: string
  highlightTerms: string[]
  effectiveChannelId: string | undefined
  isEncryptedScope: boolean
  unresolved: { from?: string; in?: string }
  /** Display name of a resolved `from:` author (for the chip), or null. */
  resolvedFromName: string | null
  channels: ChannelResponse[]
  params: MessageSearchParams | null
}

function useSearchPipeline(
  serverId: string | null,
  isOpen: boolean,
  debounced: string,
  scopeChannelId: string | undefined,
  scopeEncrypted: boolean,
  channels: ChannelResponse[],
): SearchPipeline {
  const members = useMembers(isOpen ? serverId : null).data?.items ?? EMPTY_MEMBERS

  const parsed = useMemo(() => parseSearchQuery(debounced), [debounced])
  const resolved = useMemo(
    () => resolveSearchFilters(parsed, members, channels),
    [parsed, members, channels],
  )

  const effectiveChannelId = resolved.channelId ?? scopeChannelId
  const effectiveChannel = channels.find((c) => c.id === effectiveChannelId)
  // The scope channel may not be in the accessible list (shouldn't happen), so
  // fall back to the scope's own encrypted flag when the ids match.
  const isEncryptedScope =
    effectiveChannel?.encrypted === true ||
    (scopeEncrypted && effectiveChannelId === scopeChannelId && effectiveChannelId !== undefined)

  const highlightTerms = useMemo(
    () => parsed.q.split(/\s+/).filter((t) => t.length > 0),
    [parsed.q],
  )
  const hasQuery = parsed.q.trim().length > 0

  const fromMember =
    resolved.authorId !== undefined
      ? members.find((m) => m.userId === resolved.authorId)
      : undefined
  const resolvedFromName =
    fromMember !== undefined ? (fromMember.displayName ?? fromMember.username) : null

  const params: MessageSearchParams | null =
    isOpen && serverId !== null && hasQuery && !isEncryptedScope
      ? {
          serverId,
          q: parsed.q,
          ...(effectiveChannelId !== undefined ? { channelId: effectiveChannelId } : {}),
          ...(resolved.authorId !== undefined ? { authorId: resolved.authorId } : {}),
          has: parsed.has,
        }
      : null

  return {
    q: parsed.q,
    highlightTerms,
    effectiveChannelId,
    isEncryptedScope,
    unresolved: resolved.unresolved,
    resolvedFromName,
    channels,
    params,
  }
}

/** Scope + resolved/unresolved filter chips (spec §2.3, §5.2). */
function FilterChips({
  scopeName,
  onRemoveScope,
  channelName,
  authorName,
  unresolved,
}: {
  scopeName: string | null
  onRemoveScope: () => void
  channelName: string | null
  authorName: string | null
  unresolved: { from?: string; in?: string }
}) {
  const { t } = useTranslation('search')
  const hasAny =
    scopeName !== null ||
    channelName !== null ||
    authorName !== null ||
    unresolved.from !== undefined ||
    unresolved.in !== undefined
  if (!hasAny) return null

  return (
    <div data-test="search-filter-chips" className="flex flex-wrap gap-1 px-1 pb-1">
      {scopeName !== null && (
        <Chip size="sm" variant="flat" data-test="search-scope-chip" onClose={onRemoveScope}>
          #{scopeName}
        </Chip>
      )}
      {channelName !== null && (
        <Chip size="sm" variant="flat" color="primary" data-test="search-in-chip">
          {t('inFilter', { name: channelName })}
        </Chip>
      )}
      {authorName !== null && (
        <Chip size="sm" variant="flat" color="primary" data-test="search-from-chip">
          {t('fromFilter', { name: authorName })}
        </Chip>
      )}
      {unresolved.in !== undefined && (
        <Chip size="sm" variant="flat" color="warning" data-test="search-unknown-channel">
          {t('unknownChannelFilter', { name: unresolved.in })}
        </Chip>
      )}
      {unresolved.from !== undefined && (
        <Chip size="sm" variant="flat" color="warning" data-test="search-unknown-user">
          {t('unknownUserFilter', { name: unresolved.from })}
        </Chip>
      )}
    </div>
  )
}

/** Groups server-wide results by channel; in-channel scope renders one flat group. */
function groupByChannel(
  items: MessageResponse[],
  channels: ChannelResponse[],
): Array<{ channelId: string; channelName: string; messages: MessageResponse[] }> {
  const order: string[] = []
  const byChannel = new Map<string, MessageResponse[]>()
  for (const item of items) {
    const bucket = byChannel.get(item.channelId)
    if (bucket === undefined) {
      order.push(item.channelId)
      byChannel.set(item.channelId, [item])
    } else {
      bucket.push(item)
    }
  }
  const channelNames = new Map(channels.map((c) => [c.id, c.name]))
  return order.map((channelId) => ({
    channelId,
    channelName: channelNames.get(channelId) ?? channelId,
    messages: byChannel.get(channelId) ?? [],
  }))
}

export function SearchOverlay({
  serverId,
  serverName,
  channels,
}: {
  serverId: string | null
  serverName: string | null
  /** Channels for the active server, passed from MainLayout (avoids a
   *  channels↔search import cycle). Used for `in:` resolution, encrypted-scope
   *  detection, and server-wide result grouping. */
  channels: ChannelResponse[]
}) {
  const { t } = useTranslation('search')
  const isOpen = useSearchStore((s) => s.isOpen)
  const scope = useSearchStore((s) => s.scope)
  const close = useSearchStore((s) => s.close)

  const [input, setInput] = useState('')
  const [debounced, setDebounced] = useState('')
  const [scopeRemoved, setScopeRemoved] = useState(false)

  // Reset per open — the overlay is mounted once and reused (§5.3, no history).
  useEffect(() => {
    if (isOpen) {
      setInput('')
      setDebounced('')
      setScopeRemoved(false)
    }
  }, [isOpen])

  useEffect(() => {
    const id = setTimeout(() => setDebounced(input), DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [input])

  const scopeChannelId = scopeRemoved ? undefined : scope?.channelId
  const scopeEncrypted = scopeRemoved ? false : (scope?.encrypted ?? false)
  const pipeline = useSearchPipeline(
    serverId,
    isOpen,
    debounced,
    scopeChannelId,
    scopeEncrypted,
    channels,
  )

  const search = useMessageSearch(pipeline.params)

  const placeholder =
    scopeChannelId !== undefined && scope !== null
      ? t('placeholderChannel', { channel: scope.channelName })
      : t('placeholderServer', { server: serverName ?? '' })

  function handleSelect(message: MessageResponse) {
    if (serverId === null) return
    window.dispatchEvent(
      new CustomEvent(NAVIGATE_EVENT, {
        detail: { serverId, channelId: message.channelId },
      }),
    )
    close()
  }

  const items = search.data?.pages.flatMap((p) => p.items) ?? []
  // In-channel / explicit-in scope → flat list (no channel header).
  const isScoped = pipeline.effectiveChannelId !== undefined
  const groups: Array<{
    channelId: string
    channelName: string | null
    messages: MessageResponse[]
  }> = isScoped
    ? [{ channelId: pipeline.effectiveChannelId ?? '', channelName: null, messages: items }]
    : groupByChannel(items, pipeline.channels)

  // An explicit `in:` chip only shows when it differs from the default scope.
  const inChipName =
    pipeline.effectiveChannelId !== undefined && pipeline.effectiveChannelId !== scopeChannelId
      ? (pipeline.channels.find((c) => c.id === pipeline.effectiveChannelId)?.name ?? null)
      : null

  const status = deriveStatus(search, pipeline.isEncryptedScope, pipeline.q, items.length)

  return (
    <Modal
      isOpen={isOpen}
      onClose={close}
      size="2xl"
      scrollBehavior="inside"
      data-test="search-overlay"
    >
      <ModalContent>
        <ModalHeader className="flex flex-col gap-2">
          <Input
            autoFocus
            data-test="search-input"
            aria-label={t('searchLabel')}
            type="search"
            placeholder={placeholder}
            value={input}
            onValueChange={setInput}
            startContent={<Search className="h-4 w-4 text-default-400" />}
            variant="flat"
            size="sm"
          />
          <FilterChips
            scopeName={scopeChannelId !== undefined && scope !== null ? scope.channelName : null}
            onRemoveScope={() => setScopeRemoved(true)}
            channelName={inChipName}
            authorName={pipeline.resolvedFromName}
            unresolved={pipeline.unresolved}
          />
        </ModalHeader>
        <ModalBody className="min-h-[16rem] pb-4" aria-live="polite">
          <SearchBody
            status={status}
            groups={groups}
            highlightTerms={pipeline.highlightTerms}
            onSelectResult={handleSelect}
            hasNextPage={search.hasNextPage}
            isFetchingNextPage={search.isFetchingNextPage}
            onLoadMore={() => search.fetchNextPage()}
            onRetry={() => search.refetch()}
            isRetrying={search.isRefetching}
          />
        </ModalBody>
      </ModalContent>
    </Modal>
  )
}

type SearchStatus =
  | 'idle'
  | 'encrypted'
  | 'loading'
  | 'forbidden'
  | 'ratelimited'
  | 'error'
  | 'empty'
  | 'results'

function deriveStatus(
  search: ReturnType<typeof useMessageSearch>,
  isEncryptedScope: boolean,
  q: string,
  resultCount: number,
): SearchStatus {
  if (isEncryptedScope) return 'encrypted'
  if (q.trim().length === 0) return 'idle'
  if (search.isError) {
    const err = search.error
    if (isProblemDetails(err) && err.status === 403) return 'forbidden'
    if (isProblemDetails(err) && err.status === 429) return 'ratelimited'
    return 'error'
  }
  if (search.isPending || (search.isFetching && resultCount === 0)) return 'loading'
  if (resultCount === 0) return 'empty'
  return 'results'
}

function SearchBody({
  status,
  groups,
  highlightTerms,
  onSelectResult,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  onRetry,
  isRetrying,
}: {
  status: SearchStatus
  groups: Array<{ channelId: string; channelName: string | null; messages: MessageResponse[] }>
  highlightTerms: string[]
  onSelectResult: (message: MessageResponse) => void
  hasNextPage: boolean | undefined
  isFetchingNextPage: boolean
  onLoadMore: () => void
  onRetry: () => void
  isRetrying: boolean
}) {
  const { t } = useTranslation('search')

  if (status === 'encrypted') {
    return (
      <div
        data-test="search-encrypted-notice"
        className="flex flex-col items-center gap-2 py-10 text-center"
      >
        <Lock className="h-8 w-8 text-default-300" />
        <p className="text-sm text-default-500">{t('encryptedNotice')}</p>
      </div>
    )
  }
  if (status === 'idle') {
    return (
      <p data-test="search-idle" className="py-10 text-center text-sm text-default-400">
        {t('idleHint')}
      </p>
    )
  }
  if (status === 'loading') {
    return (
      <div data-test="search-loading" className="flex justify-center py-10">
        <Spinner size="sm" />
      </div>
    )
  }
  if (status === 'forbidden') {
    return (
      <p data-test="search-forbidden" className="py-10 text-center text-sm text-danger">
        {t('channelForbidden')}
      </p>
    )
  }
  if (status === 'ratelimited') {
    return (
      <p data-test="search-ratelimited" className="py-6 text-center text-sm text-warning">
        {t('rateLimited')}
      </p>
    )
  }
  if (status === 'error') {
    return (
      <ErrorState
        icon={<Search className="h-10 w-10" />}
        message={t('error')}
        onRetry={onRetry}
        isRetrying={isRetrying}
      />
    )
  }
  if (status === 'empty') {
    return (
      <div data-test="search-empty" className="flex flex-col items-center gap-1 py-10 text-center">
        <p className="text-sm text-default-500">{t('noResults')}</p>
        <p className="text-xs text-default-400">{t('noResultsHint')}</p>
      </div>
    )
  }

  return (
    <div role="listbox" aria-label={t('searchLabel')} className="flex flex-col gap-2">
      {groups.map((group) => (
        <SearchResultsGroup
          key={group.channelId}
          channelName={group.channelName}
          messages={group.messages}
          highlightTerms={highlightTerms}
          onSelectResult={onSelectResult}
        />
      ))}
      {hasNextPage === true && (
        <Button
          data-test="search-load-more"
          variant="flat"
          size="sm"
          className="mx-auto mt-1"
          isLoading={isFetchingNextPage}
          onPress={onLoadMore}
        >
          {t('loadMore')}
        </Button>
      )}
    </div>
  )
}
