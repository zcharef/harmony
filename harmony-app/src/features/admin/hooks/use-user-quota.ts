import { useQuery } from '@tanstack/react-query'
import { getUserQuota } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'

/**
 * WHY: Founder-only quota view (GET /v1/admin/users/{id}/quota) — the selected
 * user's plan, per-user caps, and current usage. Disabled until a user is
 * selected.
 */
export function useUserQuota(userId: string | null) {
  return useQuery({
    queryKey: queryKeys.admin.userQuota(userId ?? ''),
    queryFn: async () => {
      // Non-null here: `enabled` gates the query on a selected user.
      const { data } = await getUserQuota({
        path: { id: userId ?? '' },
        throwOnError: true,
      })
      return data
    },
    enabled: userId !== null,
    staleTime: 30 * 1000,
  })
}
