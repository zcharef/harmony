import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { FriendRequestResponse } from '@/lib/api'
import { removeRequest } from '@/lib/api'
import { isProblemDetails } from '@/lib/api-error'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'

/**
 * Decline (incoming) or cancel (outgoing) a pending request — one endpoint,
 * direction inferred server-side. Optimistically drops the entry from both
 * pending caches; a 404 (already gone) stays removed (§6).
 */
export function useRemoveFriendRequest() {
  const queryClient = useQueryClient()
  const incomingKey = queryKeys.friends.requests('incoming')
  const outgoingKey = queryKeys.friends.requests('outgoing')

  return useMutation({
    mutationFn: async (otherId: string) => {
      await removeRequest({ path: { user_id: otherId }, throwOnError: true })
      return otherId
    },
    onMutate: async (otherId) => {
      await queryClient.cancelQueries({ queryKey: incomingKey })
      await queryClient.cancelQueries({ queryKey: outgoingKey })
      const previousIncoming = queryClient.getQueryData<FriendRequestResponse[]>(incomingKey)
      const previousOutgoing = queryClient.getQueryData<FriendRequestResponse[]>(outgoingKey)
      const drop = (old?: FriendRequestResponse[]) =>
        old ? old.filter((r) => r.user.id !== otherId) : old
      queryClient.setQueryData<FriendRequestResponse[]>(incomingKey, drop)
      queryClient.setQueryData<FriendRequestResponse[]>(outgoingKey, drop)
      return { previousIncoming, previousOutgoing }
    },
    onError: (error, _otherId, context) => {
      if (isProblemDetails(error) && error.status === 404) return
      if (context?.previousIncoming) {
        queryClient.setQueryData(incomingKey, context.previousIncoming)
      }
      if (context?.previousOutgoing) {
        queryClient.setQueryData(outgoingKey, context.previousOutgoing)
      }
      logger.error('remove_friend_request_failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: incomingKey })
      queryClient.invalidateQueries({ queryKey: outgoingKey })
    },
  })
}
