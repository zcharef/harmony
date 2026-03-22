import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { JoinServerRequest } from '@/lib/api'
import { joinServer } from '@/lib/api'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'

// WHY: serverId comes from the preview response, body type from OpenAPI SSoT.
interface JoinServerInput {
  serverId: string
  body: JoinServerRequest
}

/**
 * WHY: Wraps joinServer SDK in a mutation with automatic cache
 * invalidation so the server list refreshes after joining.
 */
export function useJoinServer() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ serverId, body }: JoinServerInput) => {
      const { data } = await joinServer({
        path: { id: serverId },
        body,
        throwOnError: true,
      })
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.servers.list() })
    },
    onError: (error) => {
      logger.error('join_server_failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    },
  })
}
