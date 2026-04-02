import { useQuery } from '@tanstack/react-query'
import { getMyProfile } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { useAuthStore } from '../stores/auth-store'

/**
 * WHY: Single Source of Truth for the current user's profile data (username,
 * avatar, status). Fetches from GET /v1/profiles/me — the DB profile is
 * authoritative, not Supabase user_metadata which is client-writable.
 *
 * Enabled only when a session exists (user is authenticated).
 * staleTime is high because username/avatar rarely change mid-session.
 */
export function useCurrentProfile() {
  const session = useAuthStore((s) => s.session)

  return useQuery({
    queryKey: queryKeys.profiles.me(),
    queryFn: async () => {
      const { data } = await getMyProfile({ throwOnError: true })
      return data
    },
    enabled: session !== null,
    staleTime: 5 * 60 * 1000,
  })
}
