import { useQuery } from '@tanstack/react-query'
import { listMessages } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'

/**
 * WHY: Wraps listMessages SDK call in TanStack Query.
 * Fetches messages for a specific channel. Disabled when no channelId
 * is provided (avoids firing requests before channel selection).
 *
 * WHY full response in cache: useRealtimeMessages uses setQueryData<MessageListResponse>
 * to append live messages. Storing the full envelope keeps both hooks consistent.
 */
export function useMessages(channelId: string | null) {
  return useQuery({
    queryKey: queryKeys.messages.byChannel(channelId ?? ''),
    queryFn: async () => {
      // WHY: `enabled` guard ensures channelId is non-null when queryFn runs
      if (channelId === null) throw new Error('channelId is required')
      const { data } = await listMessages({
        path: { id: channelId },
        throwOnError: true,
      })
      return data
    },
    enabled: channelId !== null,
  })
}
