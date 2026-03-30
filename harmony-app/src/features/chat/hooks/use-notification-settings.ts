import { useQuery } from '@tanstack/react-query'
import { getNotificationSettings } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'

/**
 * WHY: Fetches the current notification level for a channel.
 * Returns `{ level: 'all' }` as server default when no explicit setting exists.
 */
export function useNotificationSettings(channelId: string | null) {
  return useQuery({
    queryKey: queryKeys.notificationSettings.byChannel(channelId ?? ''),
    queryFn: async () => {
      const { data } = await getNotificationSettings({
        path: { id: channelId ?? '' },
        throwOnError: true,
      })
      return data
    },
    enabled: channelId !== null,
  })
}
