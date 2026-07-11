import { Hash } from 'lucide-react'
import type { MessageResponse } from '@/lib/api'
import { SearchResultItem } from './search-result-item'

interface SearchResultsGroupProps {
  /** Channel display name (from the channels cache), or null for an in-channel scope. */
  channelName: string | null
  messages: MessageResponse[]
  highlightTerms: string[]
  onSelectResult: (message: MessageResponse) => void
}

/**
 * A channel group: a `# name` header (server-wide results) followed by its
 * rows. In-channel scope passes `channelName = null` → no header, a flat list
 * (spec §5.1).
 */
export function SearchResultsGroup({
  channelName,
  messages,
  highlightTerms,
  onSelectResult,
}: SearchResultsGroupProps) {
  return (
    <div data-test="search-results-group" className="flex flex-col">
      {channelName !== null && (
        <div className="sticky top-0 z-10 flex items-center gap-1 bg-content1 px-2 py-1 text-xs font-semibold text-default-500">
          <Hash className="h-3.5 w-3.5" />
          <span className="truncate">{channelName}</span>
        </div>
      )}
      {messages.map((message) => (
        <SearchResultItem
          key={message.id}
          message={message}
          highlightTerms={highlightTerms}
          onSelect={() => onSelectResult(message)}
        />
      ))}
    </div>
  )
}
