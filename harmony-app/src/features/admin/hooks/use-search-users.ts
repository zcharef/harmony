import { useQuery } from '@tanstack/react-query'
import { searchUsers } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'

/**
 * WHY: Founder-only user search (GET /v1/admin/users?q=). Disabled until the
 * query is non-empty so an empty box does not spam the endpoint. The backend is
 * the real authz gate (403 for non-founders); this hook simply drives the panel.
 */
export function useSearchUsers(query: string) {
  const trimmed = query.trim()

  return useQuery({
    queryKey: queryKeys.admin.userSearch(trimmed),
    queryFn: async () => {
      const { data } = await searchUsers({
        query: { q: trimmed },
        throwOnError: true,
      })
      return data
    },
    enabled: trimmed.length > 0,
    staleTime: 30 * 1000,
  })
}
