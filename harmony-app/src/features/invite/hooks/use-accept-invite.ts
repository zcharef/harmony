import { useMutation, useQueryClient } from '@tanstack/react-query'
import { joinServer } from '@/lib/api'
import { isProblemDetails } from '@/lib/api-error'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'

interface AcceptInviteInput {
  serverId: string
  code: string
}

/**
 * Join a server from the invite LANDING PAGE.
 *
 * WHY not `useJoinServer` (server-nav): the landing page has a different
 * feedback contract — errors render INLINE on the card (ADR-028 hierarchy,
 * no toast, the page IS the context), and a 409 "already a member" is a
 * SUCCESS here (ticket: joined already → straight navigate), not an error.
 */
export function useAcceptInvite() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ serverId, code }: AcceptInviteInput) => {
      try {
        await joinServer({
          path: { id: serverId },
          body: { inviteCode: code },
          throwOnError: true,
        })
      } catch (error) {
        // WHY: 409 Conflict = already a member — for an invite landing the
        // right outcome is simply landing in the server.
        if (isProblemDetails(error) && error.status === 409) {
          return serverId
        }
        throw error
      }
      return serverId
    },
    onSuccess: async () => {
      // WHY await: MainLayout mounts immediately after this flow finishes and
      // clears any selected server missing from the cached list — refetch
      // first so the just-joined server is present before navigation.
      await queryClient.refetchQueries({ queryKey: queryKeys.servers.list() })
    },
    onError: (error) => {
      // WHY log-only here: the landing page renders the failure inline
      // (banned / server full / expired get the API's honest detail).
      logger.error('invite_join_failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    },
  })
}
