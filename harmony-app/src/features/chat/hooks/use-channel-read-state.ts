import { useQuery } from '@tanstack/react-query'
import { getChannelReadState } from '@/lib/api'
import { isProblemDetails } from '@/lib/api-error'
import { queryKeys } from '@/lib/query-keys'

/**
 * Read the caller's read position for one channel — the frozen anchor for the
 * "new messages" divider (unread-divider ticket §5.2).
 *
 * WHY `staleTime: Infinity`: the boundary is snapshotted ONCE on channel open.
 * The concurrent `mark-read` mutation advances the server `last_read_at`, but
 * this query must NOT refetch it — otherwise the divider would vanish the
 * instant the channel is marked read. The divider store freezes the value from
 * the first resolution.
 *
 * WHY `gcTime: 0`: drop the cache on channel switch so re-entry re-fetches a
 * fresh anchor (now below where the user left off), matching Discord.
 *
 * A 403/404 (lost access / older API instance) throws here and is treated as
 * "no divider" by the consumer (fail-open, ADR-027 background read).
 */
export function useChannelReadState(channelId: string | null) {
  return useQuery({
    queryKey: queryKeys.readState.byChannel(channelId ?? ''),
    queryFn: async () => {
      if (channelId === null) throw new Error('channelId is required')
      const { data } = await getChannelReadState({
        path: { id: channelId },
        throwOnError: true,
      })
      return data
    },
    enabled: channelId !== null,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    // WHY: 403 (lost access) / 404 (older API instance) are expected and never
    // succeed on retry — fail-open to "no divider" at once instead of burning
    // the global 3x backoff (~7s) before the consumer can drop the divider.
    retry: (failureCount, error) => {
      if (isProblemDetails(error) && error.status >= 400 && error.status < 500) return false
      return failureCount < 3
    },
  })
}
