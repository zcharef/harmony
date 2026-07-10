import { useQuery } from '@tanstack/react-query'
import { getChannelRoleAccess } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'

/**
 * WHY: Fetches the role-access grant set of a private channel (admin-only
 * endpoint). Enabled only when the channel is private — a public channel
 * short-circuits the read path server-side, so grants are meaningless there
 * and we must not fire the request (avoids a needless 200 + flash).
 */
export function useChannelRoleAccess(serverId: string, channelId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.channels.roleAccess(channelId),
    queryFn: async () => {
      const { data } = await getChannelRoleAccess({
        path: { id: serverId, channel_id: channelId },
        throwOnError: true,
      })
      return data
    },
    enabled,
  })
}
