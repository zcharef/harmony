import { useQuery } from '@tanstack/react-query'
import { getProfileById } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'

/**
 * Fetches any user's public account profile for the hover card (tier-2 data:
 * bio, banner, custom status, account createdAt, avatar, display name).
 *
 * WHY `enabled` gated by a non-null id AND the caller's `enabled` flag: the
 * popover only fetches while it is open (passing `enabled: isOpen`), so a closed
 * card never hits the network. Cached under `queryKeys.profiles.detail(id)` —
 * the same key `use-realtime-profile` patches live on `profile.updated`, so an
 * open card rehydrates over SSE without a refetch.
 *
 * `staleTime` is generous: profiles change rarely and SSE keeps the cache live.
 */
export function useProfile(userId: string | null, enabled = true) {
  return useQuery({
    queryKey: queryKeys.profiles.detail(userId ?? ''),
    queryFn: async () => {
      // WHY: `enabled` guard ensures userId is non-null when queryFn runs.
      if (userId === null) throw new Error('userId is required')
      const { data } = await getProfileById({
        path: { id: userId },
        throwOnError: true,
      })
      return data
    },
    enabled: enabled && userId !== null,
    staleTime: 60_000,
  })
}
