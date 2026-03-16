import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { CreateServerRequest } from '@/lib/api'
import { createServer } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'

/**
 * WHY: Wraps createServer SDK in a mutation with automatic cache
 * invalidation so the server list refreshes after creation.
 */
export function useCreateServer() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (input: CreateServerRequest) => {
      const { data } = await createServer({
        body: input,
        throwOnError: true,
      })
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.servers.all })
    },
  })
}
