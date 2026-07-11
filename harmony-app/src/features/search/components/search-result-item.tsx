import { Avatar } from '@heroui/react'
import type { MessageResponse } from '@/lib/api'
import { resolveDisplayName } from '@/lib/display-name'
import { SearchResultContent } from './search-result-content'

/** Compact absolute timestamp (search results span days — relative is ambiguous). */
function formatResultTimestamp(iso: string): string {
  const date = new Date(iso)
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

interface SearchResultItemProps {
  message: MessageResponse
  /** Word tokens from the parsed `q`, highlighted in the body (§5.4). */
  highlightTerms: string[]
  /** Jump to this result's channel (§5.5). */
  onSelect: () => void
}

/**
 * One search-result row: author avatar + name + timestamp + highlighted body.
 * A native `<button>` gives click + keyboard (Enter/Space) operability for free.
 */
export function SearchResultItem({ message, highlightTerms, onSelect }: SearchResultItemProps) {
  const authorLabel = resolveDisplayName({
    displayName: message.authorDisplayName,
    username: message.authorUsername,
  })

  return (
    <button
      type="button"
      data-test="search-result-item"
      data-message-id={message.id}
      data-channel-id={message.channelId}
      onClick={onSelect}
      className="flex w-full gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-default-100"
    >
      <Avatar
        name={authorLabel}
        src={message.authorAvatarUrl ?? undefined}
        size="sm"
        showFallback
        classNames={{ base: 'mt-0.5 h-8 w-8 shrink-0', name: 'text-xs' }}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium text-foreground">{authorLabel}</span>
          <span className="text-xs text-default-400">
            {formatResultTimestamp(message.createdAt)}
          </span>
        </div>
        <div className="min-w-0 break-words">
          <SearchResultContent
            content={message.content}
            mentions={message.mentions}
            highlightTerms={highlightTerms}
          />
        </div>
      </div>
    </button>
  )
}
