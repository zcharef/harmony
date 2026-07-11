import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { SendFriendRequestRequest } from '@/lib/api'
import { sendRequest } from '@/lib/api'
import { isProblemDetails } from '@/lib/api-error'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'

/**
 * Map a thrown API error to an inline i18n key for the Add Friend bar (§6).
 * Client-side Zod prevents most 400s before the call; a live 403 means "they
 * blocked you" (the button is pre-disabled for our own blocks).
 */
export function addFriendErrorKey(error: unknown): string {
  if (isProblemDetails(error)) {
    switch (error.status) {
      case 403:
        return 'friends:cannotAddUser'
      case 404:
        return 'friends:userNotFound'
      case 429:
        return 'friends:requestsRateLimited'
      case 409:
        // The two caps share a 409; the backend detail names which one.
        return error.detail.toLowerCase().includes('pending')
          ? 'friends:pendingCap'
          : 'friends:friendsCap'
      case 400:
        return 'friends:cannotAddUser'
      default:
        return 'friends:addFriendFailed'
    }
  }
  return 'friends:addFriendFailed'
}

/**
 * Send a friend request by user id or exact username. On `autoAccepted` the
 * friends list is invalidated; the pending caches converge via SSE.
 */
export function useSendFriendRequest() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (body: SendFriendRequestRequest) => {
      const { data } = await sendRequest({ body, throwOnError: true })
      return data
    },
    onSuccess: (result) => {
      if (result.state === 'autoAccepted') {
        queryClient.invalidateQueries({ queryKey: queryKeys.friends.list() })
      }
      queryClient.invalidateQueries({
        queryKey: queryKeys.friends.requests('outgoing'),
      })
    },
    onError: (error) => {
      // WHY log only: the Add Friend bar renders the inline message from the
      // mutation error (user-initiated, per ADR-045). No toast here.
      logger.error('send_friend_request_failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    },
  })
}
