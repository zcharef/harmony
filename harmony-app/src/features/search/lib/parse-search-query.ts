/**
 * Client-side search query grammar (spec §2.3, §5.3).
 *
 * The raw input is tokenized on whitespace into structured params. The server
 * takes ONLY structured params — it never parses a filter grammar (KISS). This
 * is a pure function (no React) so it is trivially unit-testable.
 */

export type HasFilter = 'link' | 'image'

export interface ParsedSearchQuery {
  /** Free-text remainder (everything that is not a recognised filter token). */
  q: string
  /** `from:@username` / `from:@DisplayName` → the bare name (leading `@` stripped). */
  from?: string
  /** `in:#channel-name` → the bare channel name (leading `#` stripped). */
  in?: string
  /** `has:link` / `has:image`, deduplicated, in first-seen order. */
  has: HasFilter[]
}

/** A single classified token from the raw input. `drop` = a recognised filter
 *  key with an unusable value (e.g. `has:video`) — discarded, never free text. */
type ClassifiedToken =
  | { kind: 'from'; value: string }
  | { kind: 'in'; value: string }
  | { kind: 'has'; value: HasFilter }
  | { kind: 'text'; value: string }
  | { kind: 'drop' }

/**
 * Classify one whitespace-delimited token. Filter keys are case-insensitive; a
 * token without a `key:` prefix (e.g. an email `bob@alice.com`) is free text.
 */
function classifyToken(token: string): ClassifiedToken {
  const colon = token.indexOf(':')
  if (colon <= 0) return { kind: 'text', value: token }

  const key = token.slice(0, colon).toLowerCase()
  const value = token.slice(colon + 1)

  if (key === 'from') {
    return value.length > 0
      ? { kind: 'from', value: value.replace(/^@/, '') }
      : { kind: 'text', value: token }
  }
  if (key === 'in') {
    return value.length > 0
      ? { kind: 'in', value: value.replace(/^#/, '') }
      : { kind: 'text', value: token }
  }
  if (key === 'has') {
    const v = value.toLowerCase()
    return v === 'link' || v === 'image' ? { kind: 'has', value: v } : { kind: 'drop' }
  }
  return { kind: 'text', value: token }
}

/**
 * Parse a raw search string into structured tokens (spec §2.3, §5.3).
 * An unknown `has:` value is dropped; multiple `has:` are deduplicated.
 */
export function parseSearchQuery(raw: string): ParsedSearchQuery {
  const tokens = raw.split(/\s+/).filter((t) => t.length > 0)
  const qParts: string[] = []
  const has: HasFilter[] = []
  let from: string | undefined
  let inChannel: string | undefined

  for (const token of tokens) {
    const classified = classifyToken(token)
    if (classified.kind === 'from') from = classified.value
    else if (classified.kind === 'in') inChannel = classified.value
    else if (classified.kind === 'has') {
      if (!has.includes(classified.value)) has.push(classified.value)
    } else if (classified.kind === 'text') qParts.push(classified.value)
  }

  return { q: qParts.join(' '), from, in: inChannel, has }
}
