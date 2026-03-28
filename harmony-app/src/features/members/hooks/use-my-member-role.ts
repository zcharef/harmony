import { useMemo } from 'react'
import { useAuthStore } from '@/features/auth'
import type { MemberRole } from '../moderation-types'
import { getMemberRole } from '../moderation-types'
import { useMembers } from './use-members'

interface MyMemberRoleResult {
  role: MemberRole
  isLoading: boolean
  isError: boolean
}

/**
 * WHY: Derives the current user's role in a given server from the members
 * query cache. Used by ChatArea to control moderator delete visibility
 * and by ChannelSidebar/ServerSettings for permission checks.
 *
 * Returns loading/error state so consumers can show appropriate UI rather
 * than rendering with a possibly-wrong default 'member' role.
 */
export function useMyMemberRole(serverId: string | null): MyMemberRoleResult {
  const currentUserId = useAuthStore((s) => s.user?.id ?? '')
  const { data, isPending, isError } = useMembers(serverId)

  const role = useMemo<MemberRole>(() => {
    if (data === undefined) return 'member'
    const self = data.items.find((m) => m.userId === currentUserId)
    if (self === undefined) return 'member'
    return getMemberRole(self)
  }, [data, currentUserId])

  return { role, isLoading: isPending, isError }
}
