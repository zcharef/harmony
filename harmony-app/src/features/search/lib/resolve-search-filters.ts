/**
 * Map parsed `from:`/`in:` names onto concrete IDs against the members and
 * channels caches (spec §5.3). Pure function over the two lists so it is
 * unit-testable; the overlay supplies the cached arrays.
 *
 * Unresolvable tokens are returned in `unresolved` (never silently treated as
 * free text — that would produce confusing results, spec §2.3).
 */

import type { ChannelResponse, MemberResponse } from '@/lib/api'
import type { ParsedSearchQuery } from './parse-search-query'

export interface ResolvedSearchFilters {
  /** `from:` resolved to a member's user id. */
  authorId?: string
  /** `in:` resolved to a channel id. */
  channelId?: string
  /** Tokens that matched no member/channel — rendered as "unknown" chips. */
  unresolved: {
    from?: string
    in?: string
  }
}

/**
 * Case-insensitive match of a member against a name token: prefer a prefix
 * match on username/displayName/nickname, fall back to a substring match. This
 * mirrors the members ranking used by the composer `@`-autocomplete (spec §5.1)
 * but returns a single best candidate rather than a ranked list.
 */
function memberMatchesName(member: MemberResponse, query: string): 'prefix' | 'substring' | null {
  let rank: 'prefix' | 'substring' | null = null
  for (const field of [member.username, member.displayName, member.nickname]) {
    if (field === null || field === undefined) continue
    const haystack = field.toLowerCase()
    if (haystack.startsWith(query)) return 'prefix'
    if (haystack.includes(query)) rank = 'substring'
  }
  return rank
}

function findMember(members: MemberResponse[], name: string): MemberResponse | undefined {
  const q = name.toLowerCase()
  let substringMatch: MemberResponse | undefined
  for (const member of members) {
    const rank = memberMatchesName(member, q)
    if (rank === 'prefix') return member
    if (rank === 'substring' && substringMatch === undefined) substringMatch = member
  }
  return substringMatch
}

export function resolveSearchFilters(
  parsed: ParsedSearchQuery,
  members: MemberResponse[],
  channels: ChannelResponse[],
): ResolvedSearchFilters {
  const result: ResolvedSearchFilters = { unresolved: {} }

  if (parsed.from !== undefined) {
    const match = findMember(members, parsed.from)
    if (match !== undefined) {
      result.authorId = match.userId
    } else {
      result.unresolved.from = parsed.from
    }
  }

  if (parsed.in !== undefined) {
    const wanted = parsed.in.toLowerCase()
    const exact = channels.find((c) => c.name.toLowerCase() === wanted)
    const match = exact ?? channels.find((c) => c.name.toLowerCase().startsWith(wanted))
    if (match !== undefined) {
      result.channelId = match.id
    } else {
      result.unresolved.in = parsed.in
    }
  }

  return result
}
