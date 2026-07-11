import { useQuery } from '@tanstack/react-query'
import { listPins } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'

/**
 * Fetches a channel's pinned messages (most-recently-pinned first). The bounded
 * list is not paginated (server caps it at the per-channel pin limit).
 *
 * WHY `enabled`: the panel is closed most of the time — only fetch while it is
 * open. Live pin/unpin/delete events keep the cache fresh via `useRealtimePins`
 * (setQueryData, no refetch), so there is no polling.
 */
export function usePins(channelId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.pins.byChannel(channelId),
    queryFn: async () => {
      const { data } = await listPins({
        path: { channel_id: channelId },
        throwOnError: true,
      })
      return data
    },
    enabled: enabled && channelId.length > 0,
  })
}
