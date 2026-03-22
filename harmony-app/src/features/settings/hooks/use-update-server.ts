import { useMutation, useQueryClient } from '@tanstack/react-query'
import { client } from '@/lib/api/client.gen'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'

interface UpdateServerInput {
  name?: string
  description?: string | null
}

/**
 * WHY: PATCH /v1/servers/{id} is not yet in the generated SDK.
 * Uses the raw hey-api client directly until `just gen-api` regenerates.
 */
export function useUpdateServer(serverId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (input: UpdateServerInput) => {
      const { error } = await client.patch({
        url: '/v1/servers/{id}',
        path: { id: serverId },
        body: input,
        headers: { 'Content-Type': 'application/json' },
        security: [{ scheme: 'bearer', type: 'http' }],
      })
      if (error) throw error
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.servers.all })
      queryClient.invalidateQueries({ queryKey: queryKeys.servers.detail(serverId) })
    },
    onError: (error) => {
      logger.error('Failed to update server', {
        serverId,
        error: error instanceof Error ? error.message : String(error),
      })
    },
  })
}
