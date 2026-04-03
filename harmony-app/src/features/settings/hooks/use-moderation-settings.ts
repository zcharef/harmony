import { useQuery } from '@tanstack/react-query'
import { getModerationSettings } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'

export function useModerationSettings(serverId: string) {
  return useQuery({
    queryKey: queryKeys.servers.moderation(serverId),
    queryFn: async () => {
      const { data } = await getModerationSettings({
        path: { id: serverId },
        throwOnError: true,
      })
      return data
    },
    enabled: serverId.length > 0,
  })
}
