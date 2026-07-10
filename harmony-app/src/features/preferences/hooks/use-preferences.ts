import { useQuery } from '@tanstack/react-query'
import { getPreferences } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'

/**
 * WHY: Fetches the current user's global preferences (DND, notification
 * switches, etc.). Returns server defaults when no explicit row exists.
 *
 * WHY explicit freshness options: `refetchOnWindowFocus` is globally disabled
 * (App.tsx) and JWT-rotation reconnects skip invalidation — without these a
 * preference change on device B would never reach a healthy device A.
 * Guarantee: it lands at the next window focus (or genuine SSE reconnect).
 */
export function usePreferences() {
  return useQuery({
    queryKey: queryKeys.preferences.me(),
    queryFn: async () => {
      const { data } = await getPreferences({
        throwOnError: true,
      })
      return data
    },
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  })
}
