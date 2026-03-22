import { useMutation, useQueryClient } from '@tanstack/react-query'
import { client } from '@/lib/api/client.gen'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'
import type { ChangeRoleRequest } from '../moderation-types'

/**
 * WHY: PATCH /v1/servers/{server_id}/members/{user_id}/role is not yet in the
 * generated SDK. Uses the raw hey-api client directly until `just gen-api`
 * regenerates the SDK with the new endpoint.
 */
export function useChangeRole(serverId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: ChangeRoleRequest['role'] }) => {
      const { error } = await client.patch({
        url: '/v1/servers/{server_id}/members/{user_id}/role',
        path: { server_id: serverId, user_id: userId },
        body: { role },
        headers: { 'Content-Type': 'application/json' },
        security: [{ scheme: 'bearer', type: 'http' }],
      })
      if (error) throw error
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.servers.members(serverId) })
    },
    onError: (error) => {
      logger.error('Failed to change member role', {
        serverId,
        error: error instanceof Error ? error.message : String(error),
      })
    },
  })
}
