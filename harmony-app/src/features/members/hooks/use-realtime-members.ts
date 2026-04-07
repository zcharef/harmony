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
 * Subscribes to SSE member events and updates the TanStack Query cache on:
 * - member.joined: new member appended to the list
 * - member.removed: member removed from the list
 * - member.role_updated: member replaced in-place
 *
 * WHY direct cache update instead of invalidation: avoids a network
 * round-trip per event, keeping the member list feel instant.
 *
 * WHY no serverId filter: SSE delivers events for ALL servers the user
 * belongs to. Filtering by selectedServerId caused missed updates — when the
 * user viewed server Y, member events for server X were silently dropped.
 * Combined with the 5-min global staleTime, navigating back to X showed a
 * stale member list. Using the event's own serverId as the cache key ensures
 * every server's cache stays current. The `if (!old) return undefined` guard
 * prevents creating phantom cache entries for un-fetched servers.
 *
 * WHY no parameter: This hook is mounted in MainLayout (behind auth guard),
 * so it is inherently active whenever the user is logged in. Same pattern as
 * useRealtimeDms().
 */
export function useRealtimeMembers() {
  const queryClient = useQueryClient()

  const handleMemberJoined = useCallback(
    (payload: unknown) => {
      const parsed = memberEventSchema.safeParse(payload)
      if (!parsed.success) {
        logger.error('Malformed member.joined SSE payload', {
          error: parsed.error.message,
        })
        return
      }

      const eventServerId = parsed.data.serverId
      const member = toMemberResponse(parsed.data.member)

      queryClient.setQueryData<MemberListResponse>(
        queryKeys.servers.members(eventServerId),
        (old) => {
          if (!old) return undefined

          // WHY: Deduplicate — skip if member already exists in the list.
          const alreadyExists = old.items.some((m) => m.userId === member.userId)
          if (alreadyExists) return old

          return {
            ...old,
            items: [...old.items, member],
          }
        },
      )
    },
    [queryClient],
  )

  const handleMemberRemoved = useCallback(
    (payload: unknown) => {
      const parsed = memberRemovedSchema.safeParse(payload)
      if (!parsed.success) {
        logger.error('Malformed member.removed SSE payload', {
          error: parsed.error.message,
        })
        return
      }

      const eventServerId = parsed.data.serverId

      queryClient.setQueryData<MemberListResponse>(
        queryKeys.servers.members(eventServerId),
        (old) => {
          if (!old) return undefined

          const filtered = old.items.filter((m) => m.userId !== parsed.data.userId)
          // WHY: If no member was actually removed, return old to avoid re-render.
          if (filtered.length === old.items.length) return old

          return {
            ...old,
            items: filtered,
          }
        },
      )
    },
    [queryClient],
  )

  const handleMemberRoleUpdated = useCallback(
    (payload: unknown) => {
      const parsed = memberEventSchema.safeParse(payload)
      if (!parsed.success) {
        logger.error('Malformed member.role_updated SSE payload', {
          error: parsed.error.message,
        })
        return
      }

      const eventServerId = parsed.data.serverId
      const member = toMemberResponse(parsed.data.member)

      queryClient.setQueryData<MemberListResponse>(
        queryKeys.servers.members(eventServerId),
        (old) => {
          if (!old) return undefined

          return {
            ...old,
            items: old.items.map((m) => (m.userId === member.userId ? member : m)),
          }
        },
      )
    },
    [queryClient],
  )

  useServerEvent('member.joined', handleMemberJoined)
  useServerEvent('member.removed', handleMemberRemoved)
  useServerEvent('member.role_updated', handleMemberRoleUpdated)
}
