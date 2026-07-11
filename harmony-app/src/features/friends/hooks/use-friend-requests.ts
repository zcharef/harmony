import { useQuery } from '@tanstack/react-query'
import { listRequests } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'

export type RequestDirection = 'incoming' | 'outgoing'

/**
 * The caller's pending friend requests in one direction, newest first (§3.1).
 * Returns the envelope's `items` array.
 */
export function useFriendRequests(direction: RequestDirection) {
  return useQuery({
    queryKey: queryKeys.friends.requests(direction),
    queryFn: async () => {
      const { data } = await listRequests({ query: { direction }, throwOnError: true })
      return data.items
    },
  })
}
