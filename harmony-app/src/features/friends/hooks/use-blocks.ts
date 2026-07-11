import { useQuery } from '@tanstack/react-query'
import { listBlocks } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'

/**
 * The caller's blocked users, newest first (§3.1). Returns the envelope's
 * `items` array.
 */
export function useBlocks() {
  return useQuery({
    queryKey: queryKeys.friends.blocks(),
    queryFn: async () => {
      const { data } = await listBlocks({ throwOnError: true })
      return data.items
    },
  })
}
