import { useQuery } from '@tanstack/react-query'
import { listReports } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'

/**
 * Open reports queue for a server (moderator+). Exposes `openCount` for the
 * tab badge. Reports are a pull surface (§4.3) — no SSE; the list refetches on
 * tab open and after each mutation via cache patches in the mutation hooks.
 */
export function useReports(serverId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.servers.reports(serverId),
    enabled,
    queryFn: async () => {
      const { data } = await listReports({
        path: { id: serverId },
        query: { status: 'open' },
        throwOnError: true,
      })
      return data
    },
  })
}
