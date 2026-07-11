import { useInfiniteQuery } from '@tanstack/react-query'
import { listModerationLog } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'

/** The `before` cursor for the first page (none). Typed so `pageParam` widens
 *  to `string | undefined` without an `as` assertion (ADR-035). */
const INITIAL_CURSOR: string | undefined = undefined

/**
 * Infinite (cursor-paginated) moderation audit log for a server (admin+).
 * The API returns `{ items, nextCursor }`; `nextCursor` drives "Load more".
 */
export function useModerationLog(serverId: string) {
  return useInfiniteQuery({
    queryKey: queryKeys.servers.moderationLog(serverId),
    initialPageParam: INITIAL_CURSOR,
    queryFn: async ({ pageParam }) => {
      const { data } = await listModerationLog({
        path: { id: serverId },
        query: pageParam === undefined ? undefined : { before: pageParam },
        throwOnError: true,
      })
      return data
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  })
}
