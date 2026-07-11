import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { FriendRequestResponse } from '@/lib/api'
import { acceptRequest } from '@/lib/api'
import { isProblemDetails } from '@/lib/api-error'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'

/**
 * Accept a pending incoming request. Optimistically drops the entry from the
 * incoming cache; the new friend arrives via the `friend.added` SSE handler.
 * A 404 (cancel/block raced us) is treated as success-with-cleanup — the stale
 * entry stays removed, no toast (§6).
 */
export function useAcceptFriendRequest() {
  const queryClient = useQueryClient()
  const incomingKey = queryKeys.friends.requests('incoming')

  return useMutation({
    mutationFn: async (requesterId: string) => {
      const { data } = await acceptRequest({
        path: { user_id: requesterId },
        throwOnError: true,
      })
      return data
    },
    onMutate: async (requesterId) => {
      await queryClient.cancelQueries({ queryKey: incomingKey })
      const previous = queryClient.getQueryData<FriendRequestResponse[]>(incomingKey)
      queryClient.setQueryData<FriendRequestResponse[]>(incomingKey, (old) =>
        old ? old.filter((r) => r.user.id !== requesterId) : old,
      )
      return { previous }
    },
    onError: (error, _requesterId, context) => {
      // WHY: 404 = the request is already gone (cancelled / block raced). The
      // end state matches intent (no pending request) — keep it removed.
      if (isProblemDetails(error) && error.status === 404) return
      if (context?.previous) {
        queryClient.setQueryData(incomingKey, context.previous)
      }
      logger.error('accept_friend_request_failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: incomingKey })
      queryClient.invalidateQueries({ queryKey: queryKeys.friends.list() })
    },
  })
}
