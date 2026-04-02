import { useQuery } from '@tanstack/react-query'
import { getPreferences } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'

/**
 * WHY: Fetches the current user's global preferences (DND, etc.).
 * Returns server defaults (`dndEnabled: false`) when no explicit row exists.
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
  })
}
