import { useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { z } from 'zod'
import { useServerEvent } from '@/hooks/use-server-event'
import type { MemberListResponse, MemberResponse } from '@/lib/api'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'

/**
 * WHY local schema (not imported from event-types.ts): useEventSource already
 * validates the full discriminated union via serverEventSchema. This local schema
 * validates only the subset of fields needed for cache mutation (no `type`,
 * `senderId`, etc.), and maps them to MemberResponse via toMemberResponse().
 * Keeping it local makes the handler self-contained and avoids coupling to the
 * full event shape.
 */
const memberPayloadSchema = z.object({
  userId: z.string(),
  username: z.string(),
  avatarUrl: z.string().nullable().optional(),
  nickname: z.string().nullable().optional(),
  role: z.string(),
  joinedAt: z.string(),
})

/** WHY: member.removed only carries userId + serverId, not the full member. */
const memberRemovedSchema = z.object({
  serverId: z.string(),
  userId: z.string(),
})

/** WHY: member.joined and member.role_updated carry the full member payload. */
const memberEventSchema = z.object({
  serverId: z.string(),
  member: memberPayloadSchema,
})

function toMemberResponse(payload: z.infer<typeof memberPayloadSchema>): MemberResponse {
  return {
    userId: payload.userId,
    username: payload.username,
    avatarUrl: payload.avatarUrl,
    nickname: payload.nickname,
    role: payload.role,
    joinedAt: payload.joinedAt,
  }
}

/**
 * Subscribes to SSE member events for a given server and updates
 * the TanStack Query cache on:
 * - member.joined: new member appended to the list
 * - member.removed: member removed from the list
 * - member.role_updated: member replaced in-place
 *
 * WHY direct cache update instead of invalidation: avoids a network
 * round-trip per event, keeping the member list feel instant.
 */
export function useRealtimeMembers(serverId: string) {
  const queryClient = useQueryClient()

  const handleMemberJoined = useCallback(
    (payload: unknown) => {
      if (serverId.length === 0) return

      const parsed = memberEventSchema.safeParse(payload)
      if (!parsed.success) {
        logger.error('Malformed member.joined SSE payload', {
          serverId,
          error: parsed.error.message,
        })
        return
      }

      // WHY: Only process events for the server this hook is watching.
      if (parsed.data.serverId !== serverId) return

      const member = toMemberResponse(parsed.data.member)

      queryClient.setQueryData<MemberListResponse>(queryKeys.servers.members(serverId), (old) => {
        if (!old) return undefined

        // WHY: Deduplicate — skip if member already exists in the list.
        const alreadyExists = old.items.some((m) => m.userId === member.userId)
        if (alreadyExists) return old

        return {
          ...old,
          items: [...old.items, member],
          total: old.total + 1,
        }
      })
    },
    [serverId, queryClient],
  )

  const handleMemberRemoved = useCallback(
    (payload: unknown) => {
      if (serverId.length === 0) return

      const parsed = memberRemovedSchema.safeParse(payload)
      if (!parsed.success) {
        logger.error('Malformed member.removed SSE payload', {
          serverId,
          error: parsed.error.message,
        })
        return
      }

      if (parsed.data.serverId !== serverId) return

      queryClient.setQueryData<MemberListResponse>(queryKeys.servers.members(serverId), (old) => {
        if (!old) return undefined

        const filtered = old.items.filter((m) => m.userId !== parsed.data.userId)
        // WHY: If no member was actually removed, return old to avoid re-render.
        if (filtered.length === old.items.length) return old

        return {
          ...old,
          items: filtered,
          total: Math.max(0, old.total - 1),
        }
      })
    },
    [serverId, queryClient],
  )

  const handleMemberRoleUpdated = useCallback(
    (payload: unknown) => {
      if (serverId.length === 0) return

      const parsed = memberEventSchema.safeParse(payload)
      if (!parsed.success) {
        logger.error('Malformed member.role_updated SSE payload', {
          serverId,
          error: parsed.error.message,
        })
        return
      }

      if (parsed.data.serverId !== serverId) return

      const member = toMemberResponse(parsed.data.member)

      queryClient.setQueryData<MemberListResponse>(queryKeys.servers.members(serverId), (old) => {
        if (!old) return undefined

        return {
          ...old,
          items: old.items.map((m) => (m.userId === member.userId ? member : m)),
        }
      })
    },
    [serverId, queryClient],
  )

  useServerEvent(serverId.length > 0 ? 'member.joined' : null, handleMemberJoined)
  useServerEvent(serverId.length > 0 ? 'member.removed' : null, handleMemberRemoved)
  useServerEvent(serverId.length > 0 ? 'member.role_updated' : null, handleMemberRoleUpdated)
}
