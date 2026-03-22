import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { CreateInviteRequest } from '@/lib/api'
import { createInvite } from '@/lib/api'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'

/**
 * WHY: Wraps createInvite SDK in a mutation with automatic cache
 * invalidation so the invite list refreshes after creation.
 */
export function useCreateInvite(serverId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (input: CreateInviteRequest) => {
      const { data } = await createInvite({
        path: { id: serverId },
        body: input,
        throwOnError: true,
      })
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.servers.invites(serverId) })
    },
    onError: (error) => {
      logger.error('create_invite_failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    },
  })
}
