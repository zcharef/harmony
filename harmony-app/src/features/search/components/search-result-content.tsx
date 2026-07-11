import { Fragment, type ReactNode } from 'react'
import type { MentionedUserResponse } from '@/lib/api'
import { resolveDisplayName } from '@/lib/display-name'

/**
 * Search-result content renderer (spec §5.4). Renders the plain message body
 * with `<@uuid>` mention markers replaced by `@name` and the matched query
 * terms wrapped in `<mark>`. Highlight is cosmetic and literal-token — a term
 * that spans markdown may not wrap, which is acceptable (§5.4, §10).
 *
 * WHY not the full markdown pipeline: a result row is a preview, and reusing
 * the chat renderer's private `MessageContent` is not possible without editing
 * that module. This keeps the search feature self-contained.
 */

// A `<@uuid>` mention marker (uuid = 36 chars). Local to the preview renderer.
const MENTION_MARKER_RE = /<@([0-9a-fA-F-]{36})>/g

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function replaceMentionMarkers(
  content: string,
  mentions: MentionedUserResponse[] | undefined,
): string {
  if (mentions === undefined || mentions.length === 0) return content
  return content.replace(MENTION_MARKER_RE, (_marker, id: string) => {
    const found = mentions.find((m) => m.userId === id)
    if (found === undefined) return '@unknown'
    return `@${resolveDisplayName({ displayName: found.displayName, username: found.username })}`
  })
}

interface SearchResultContentProps {
  content: string
  mentions: MentionedUserResponse[] | undefined
  /** Word tokens from the parsed `q` to highlight (case-insensitive). */
  highlightTerms: string[]
}

export function SearchResultContent({
  content,
  mentions,
  highlightTerms,
}: SearchResultContentProps) {
  const text = replaceMentionMarkers(content, mentions)
  const terms = highlightTerms.map(escapeRegExp).filter((t) => t.length > 0)

  if (terms.length === 0) {
    return <span className="text-sm text-foreground/90">{text}</span>
  }

  // Split on a single capture group → matches land at odd indices.
  const re = new RegExp(`(${terms.join('|')})`, 'gi')
  const parts = text.split(re)
  let offset = 0
  const segments: ReactNode[] = []
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (part === undefined || part.length === 0) {
      if (part !== undefined) offset += part.length
      continue
    }
    if (i % 2 === 1) {
      segments.push(
        <mark key={offset} data-test="search-highlight" className="rounded bg-warning/30 px-0.5">
          {part}
        </mark>,
      )
    } else {
      segments.push(<Fragment key={offset}>{part}</Fragment>)
    }
    offset += part.length
  }

  return <span className="text-sm text-foreground/90">{segments}</span>
}
