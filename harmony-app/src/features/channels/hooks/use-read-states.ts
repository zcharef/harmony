import { useQuery } from '@tanstack/react-query'
import { listServerReadStates } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { useUnreadStore } from '../stores/unread-store'

export function useReadStates(serverId: string | null) {
  const initFromServer = useUnreadStore((s) => s.initFromServer)

  return useQuery({
    queryKey: queryKeys.readStates.byServer(serverId ?? ''),
    queryFn: async () => {
      // WHY: `enabled: serverId !== null` guards this — queryFn never runs when null
      const id = serverId ?? ''
      const { data } = await listServerReadStates({
        path: { id },
        throwOnError: true,
      })
      initFromServer(data.items)
      return data
    },
    enabled: serverId !== null,
  })
}
