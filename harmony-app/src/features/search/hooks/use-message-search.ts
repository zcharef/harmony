import { useInfiniteQuery } from '@tanstack/react-query'
import { type MessageSearchResponse, searchMessages } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import type { HasFilter } from '../lib/parse-search-query'

/**
 * Structured search request (already parsed + resolved client-side, spec §5.3).
 * `null` disables the query entirely (idle / empty / encrypted-scope states).
 */
export interface MessageSearchParams {
  serverId: string
  /** Free-text query. The hook is disabled while this is empty (§1, §3.2b). */
  q: string
  channelId?: string
  authorId?: string
  has: HasFilter[]
}

/** Stable, serialisable projection of the params for the query key (ADR-029). */
function paramsKey(params: MessageSearchParams): Record<string, unknown> {
  return {
    q: params.q,
    channelId: params.channelId ?? null,
    authorId: params.authorId ?? null,
    has: [...params.has].sort(),
  }
}

/**
 * `useInfiniteQuery` over `searchMessages` (spec §5.1). `throwOnError: true` so
 * TanStack Query sees API failures (ADR: use-members.ts). Relevance keyset
 * pagination via the opaque `nextCursor` (best-match-first, not recency).
 * Enabled only when `q` is non-empty — a bare filter without `q` is a 400
 * server-side (§3.2b), so it never fires.
 */
export function useMessageSearch(params: MessageSearchParams | null) {
  return useInfiniteQuery({
    queryKey: queryKeys.search.messages(params?.serverId ?? '', params ? paramsKey(params) : {}),
    queryFn: async ({ pageParam }) => {
      if (params === null) throw new Error('search params are required')
      const { data } = await searchMessages({
        path: { id: params.serverId },
        query: {
          q: params.q,
          ...(params.channelId !== undefined ? { channelId: params.channelId } : {}),
          ...(params.authorId !== undefined ? { authorId: params.authorId } : {}),
          ...(params.has.length > 0 ? { has: params.has.join(',') } : {}),
          ...(typeof pageParam === 'string' ? { cursor: pageParam } : {}),
        },
        throwOnError: true,
      })
      return data
    },
    initialPageParam: undefined satisfies string | undefined,
    getNextPageParam: (last: MessageSearchResponse) => last.nextCursor ?? undefined,
    enabled: params !== null && params.q.trim().length > 0,
  })
}
