import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { listOfficialBadges } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'

/**
 * The set of user IDs holding the "Harmony Official" verified badge.
 *
 * WHY a shared set (not a per-message flag): the badge must render next to EVERY
 * message author, so bloating each message payload with `isOfficial` would be
 * wasteful. Instead the (tiny — staff only) official set is fetched once and
 * cached; `message-item`, the profile card and the member list each check
 * author-id membership in O(1).
 *
 * Reactivity: on a genuine SSE reconnect `useFetchSSE` invalidates all queries
 * (ADR-SSE-006), so a grant applied while disconnected is picked up on reconnect
 * without a dedicated badge event (grants are rare admin actions).
 *
 * `staleTime` is generous — the set changes only on a manual owner grant.
 */
export function useOfficialBadges(): Set<string> {
  const { data } = useQuery({
    queryKey: queryKeys.badges.official(),
    queryFn: async () => {
      const { data } = await listOfficialBadges({ throwOnError: true })
      return data
    },
    staleTime: 5 * 60_000,
  })

  // WHY useMemo: keep a stable Set identity across renders so consumers memoized
  // on it (e.g. the virtualized message list) don't re-render on every tick.
  return useMemo(() => new Set(data?.userIds ?? []), [data])
}
