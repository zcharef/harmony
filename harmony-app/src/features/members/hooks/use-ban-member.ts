import { useMutation, useQueryClient } from '@tanstack/react-query'
import { client } from '@/lib/api/client.gen'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'
import type { CreateBanRequest } from '../moderation-types'

/**
 * WHY: POST /v1/servers/{server_id}/bans is not yet in the generated SDK.
 * Uses the raw hey-api client directly.
 */
export function useBanMember(serverId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (input: CreateBanRequest) => {
      const { error } = await client.post({
        url: '/v1/servers/{server_id}/bans',
        path: { server_id: serverId },
        body: input,
        headers: { 'Content-Type': 'application/json' },
        security: [{ scheme: 'bearer', type: 'http' }],
      })
      if (error) throw error
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.servers.members(serverId) })
    },
    onError: (error) => {
      logger.error('Failed to ban member', {
        serverId,
        error: error instanceof Error ? error.message : String(error),
      })
    },
  })
}
