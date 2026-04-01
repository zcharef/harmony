import { useQueries } from '@tanstack/react-query'
import { listServerReadStates } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { useUnreadStore } from '../stores/unread-store'

/**
 * WHY: Fetches read states for ALL servers in parallel on initial load.
 * Without this, only the selected server's unread counts are loaded —
 * non-selected server icons show 0 unread until a new SSE event arrives.
 * initFromServer merges (not replaces), so each server's counts coexist.
 *
 * TODO: Replace N parallel requests with a batch endpoint (e.g.
 * `POST /v1/read-states/batch`) when DM count grows — a user with
 * 50 DMs fires 50 requests on login and on every SSE reconnect.
 */
export function useAllReadStates(serverIds: readonly string[]) {
  const initFromServer = useUnreadStore((s) => s.initFromServer)

  useQueries({
    queries: serverIds.map((serverId) => ({
      queryKey: queryKeys.readStates.byServer(serverId),
      queryFn: async () => {
        const { data } = await listServerReadStates({
          path: { id: serverId },
          throwOnError: true,
        })
        initFromServer(data.items)
        return data
      },
    })),
  })
}
