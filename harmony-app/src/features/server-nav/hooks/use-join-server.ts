import { useMutation, useQueryClient } from '@tanstack/react-query'
import { joinServer } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'

interface JoinServerInput {
  serverId: string
  inviteCode: string
}

/**
 * WHY: Wraps joinServer SDK in a mutation with automatic cache
 * invalidation so the server list refreshes after joining.
 */
export function useJoinServer() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ serverId, inviteCode }: JoinServerInput) => {
      const { data } = await joinServer({
        path: { id: serverId },
        body: { inviteCode },
        throwOnError: true,
      })
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.servers.list() })
    },
  })
}
