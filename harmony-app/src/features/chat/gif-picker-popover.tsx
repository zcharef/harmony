import type { PopoverProps } from '@heroui/react'
import { Button, Input, Popover, PopoverContent, PopoverTrigger, Spinner } from '@heroui/react'
import { Search } from 'lucide-react'
import { type ReactNode, type UIEvent, useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { GifItem } from '@/lib/api'
import { isProblemDetails } from '@/lib/api-error'
import { EXTERNAL_LINKS } from '@/lib/external-links'
import { cn } from '@/lib/utils'
import { useDebouncedValue } from './hooks/use-debounced-value'
import { useSearchGifs } from './hooks/use-search-gifs'
import { useTrendingGifs } from './hooks/use-trending-gifs'

const SEARCH_DEBOUNCE_MS = 300

/** Pixels-from-bottom threshold that triggers loading the next page. */
const INFINITE_SCROLL_THRESHOLD_PX = 240

interface GifPickerPopoverProps {
  isOpen: boolean
  onOpenChange: (isOpen: boolean) => void
  /** WHY: receives the hosted GIF URL. The popover closes itself after selection. */
  onGifSelect: (gifUrl: string) => void
  placement?: PopoverProps['placement']
  /** The trigger element (a HeroUI Button). */
  children: ReactNode
}

/**
 * GIF picker mirroring `emoji-picker-popover.tsx`: same Popover skeleton and
 * prop contract. The body only mounts while the popover is open (so no request
 * fires when closed), auto-fetches trending, switches to search on input, and
 * always shows the "Powered by KLIPY" attribution (Klipy ToS).
 */
export function GifPickerPopover({
  isOpen,
  onOpenChange,
  onGifSelect,
  placement = 'top-end',
  children,
}: GifPickerPopoverProps) {
  return (
    <Popover isOpen={isOpen} onOpenChange={onOpenChange} placement={placement}>
      <PopoverTrigger>{children}</PopoverTrigger>
      <PopoverContent className="p-0">
        {/* WHY body-as-child: PopoverContent only mounts its children when open,
            so the trending/search hooks run lazily on first open. */}
        {isOpen ? (
          <GifPickerBody
            onSelect={(url) => {
              onGifSelect(url)
              onOpenChange(false)
            }}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

function GifPickerBody({ onSelect }: { onSelect: (gifUrl: string) => void }) {
  const { t } = useTranslation('chat')
  const [rawQuery, setRawQuery] = useState('')
  const debouncedQuery = useDebouncedValue(rawQuery, SEARCH_DEBOUNCE_MS)
  const isSearching = debouncedQuery.trim().length > 0

  const trending = useTrendingGifs(!isSearching)
  const search = useSearchGifs(debouncedQuery, isSearching)
  const active = isSearching ? search : trending

  const items = useMemo(() => active.data?.pages.flatMap((page) => page.items) ?? [], [active.data])

  // WHY destructure: TanStack returns a fresh `active` object every render, so
  // depending on it would recreate the callback (and re-attach the scroll
  // listener) each render. Depend only on the stable fields we use.
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = active
  const canLoadMore = hasNextPage === true && isFetchingNextPage === false
  const handleScroll = useCallback(
    (e: UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget
      const remaining = el.scrollHeight - el.scrollTop - el.clientHeight
      if (remaining < INFINITE_SCROLL_THRESHOLD_PX && canLoadMore) {
        void fetchNextPage()
      }
    },
    [canLoadMore, fetchNextPage],
  )

  return (
    <div className="flex w-72 flex-col gap-2 p-2" data-test="gif-picker">
      <Input
        autoFocus
        size="sm"
        variant="flat"
        value={rawQuery}
        onValueChange={setRawQuery}
        placeholder={t('gif.searchPlaceholder')}
        startContent={<Search className="h-4 w-4 text-default-400" />}
        aria-label={t('gif.searchPlaceholder')}
        data-test="gif-search-input"
      />

      <div className="h-64 overflow-y-auto" onScroll={handleScroll} data-test="gif-grid">
        <GifGrid
          items={items}
          isPending={active.isPending}
          isError={active.isError}
          error={active.error}
          isSearching={isSearching}
          query={debouncedQuery.trim()}
          isPlaceholder={active.isPlaceholderData}
          isFetchingNextPage={active.isFetchingNextPage}
          onRetry={() => void active.refetch()}
          onSelect={onSelect}
        />
      </div>

      {/* Klipy ToS: the attribution must stay visible, never gated behind scroll. */}
      <a
        href={EXTERNAL_LINKS.KLIPY}
        target="_blank"
        rel="noreferrer"
        className="px-1 text-center text-[10px] text-default-400 hover:underline"
        data-test="gif-attribution"
      >
        {t('gif.poweredBy')}
      </a>
    </div>
  )
}

function GifGrid({
  items,
  isPending,
  isError,
  error,
  isSearching,
  query,
  isPlaceholder,
  isFetchingNextPage,
  onRetry,
  onSelect,
}: {
  items: GifItem[]
  isPending: boolean
  isError: boolean
  error: unknown
  isSearching: boolean
  query: string
  isPlaceholder: boolean
  isFetchingNextPage: boolean
  onRetry: () => void
  onSelect: (gifUrl: string) => void
}) {
  const { t } = useTranslation('chat')

  // WHY 429 gets its own copy: a rate-limit is non-destructive — the input
  // stays usable and results reappear once the window drains (ticket §6).
  const isRateLimited = isProblemDetails(error) && error.status === 429
  const errorMessage = isRateLimited ? t('gif.rateLimited') : t('gif.loadFailed')

  // ADR-028: a failed picker fetch is a network problem, not a crash — inline
  // message + retry, breadcrumb only, never a toast/Sentry. When we still hold
  // stale results (e.g. a 429 during refetch), keep them on screen with a small
  // banner instead of replacing the grid.
  if (isError && items.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2" data-test="gif-error">
        <p className="px-4 text-center text-xs text-default-500">{errorMessage}</p>
        <Button size="sm" variant="flat" onPress={onRetry} data-test="gif-retry">
          {t('gif.retry')}
        </Button>
      </div>
    )
  }

  if (isPending) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size="sm" />
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <p
        className="flex h-full items-center justify-center px-4 text-center text-xs text-default-500"
        data-test="gif-empty"
      >
        {isSearching ? t('gif.noResults', { query }) : t('gif.trendingEmpty')}
      </p>
    )
  }

  return (
    <div className={cn('columns-2 gap-1', isPlaceholder && 'opacity-60')}>
      {isError && (
        <p
          className="mb-1 px-1 text-center text-[10px] text-default-500"
          data-test="gif-inline-error"
        >
          {errorMessage}
        </p>
      )}
      {items.map((gif) => (
        <button
          key={gif.id}
          type="button"
          onClick={() => onSelect(gif.url)}
          className="mb-1 block w-full overflow-hidden rounded transition-opacity hover:opacity-80"
          data-test="gif-item"
        >
          <img
            src={gif.previewUrl}
            alt={gif.title}
            loading="lazy"
            className="w-full rounded"
            width={gif.width}
            height={gif.height}
          />
        </button>
      ))}
      {isFetchingNextPage ? (
        <div className="flex justify-center py-2">
          <Spinner size="sm" />
        </div>
      ) : null}
    </div>
  )
}
