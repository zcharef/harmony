import { useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { z } from 'zod'
import { useAuthStore } from '@/features/auth'
import { getMemberRole, type MemberRole } from '@/features/members'
import { useServerEvent } from '@/hooks/use-server-event'
import type { ChannelResponse, MemberListResponse } from '@/lib/api'
import { zChannelType } from '@/lib/api/zod.gen'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'

/**
 * WHY local schema (not imported from event-types.ts): useEventSource already
 * validates the full discriminated union via serverEventSchema. This local schema
 * validates only the subset of fields needed for cache mutation (no `type`,
 * `senderId`, etc.), and maps them to ChannelResponse via toChannelResponse().
 * Keeping it local makes the handler self-contained and avoids coupling to the
 * full event shape.
 */
const channelPayloadSchema = z.object({
  id: z.string(),
  name: z.string(),
  topic: z.string().nullable().optional(),
  channelType: zChannelType,
  position: z.number(),
  isPrivate: z.boolean(),
  isReadOnly: z.boolean(),
  encrypted: z.boolean(),
  slowModeSeconds: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** WHY: channel.created and channel.updated carry the full channel payload. */
const channelEventSchema = z.object({
  serverId: z.string(),
  channel: channelPayloadSchema,
})

/** WHY: channel.deleted only carries channelId + serverId, not the full channel. */
const channelDeletedSchema = z.object({
  serverId: z.string(),
  channelId: z.string(),
})

/**
 * WHY: channel.access_updated carries the channel id + the granted role set
 * only (NOT name/topic — bounded metadata, no content leak). The client
 * re-evaluates visibility of a PRIVATE channel whose grants changed.
 */
const channelAccessUpdatedSchema = z.object({
  serverId: z.string(),
  channelId: z.string(),
  authorizedRoles: z.array(z.enum(['moderator', 'member'])),
})

/**
 * WHY subset (serverId + member.userId only): this hook only needs to know
 * WHOSE role changed to re-evaluate channel visibility — the members feature
 * owns the full member cache update.
 */
const memberRoleUpdatedSchema = z.object({
  serverId: z.string(),
  member: z.object({ userId: z.string() }),
})

/**
 * WHY: The useChannels hook stores `data.items` (ChannelResponse[]) directly,
 * not the full ChannelListResponse envelope. The queryFn returns `data.items`.
 * See use-channels.ts:L20.
 */
function toChannelResponse(
  payload: z.infer<typeof channelPayloadSchema>,
  serverId: string,
): ChannelResponse {
  return {
    id: payload.id,
    channelType: payload.channelType,
    createdAt: payload.createdAt,
    encrypted: payload.encrypted,
    isPrivate: payload.isPrivate,
    isReadOnly: payload.isReadOnly,
    name: payload.name,
    position: payload.position,
    serverId,
    slowModeSeconds: payload.slowModeSeconds,
    topic: payload.topic,
    updatedAt: payload.updatedAt,
  }
}

/**
 * Subscribes to SSE channel events and updates the TanStack Query cache on:
 * - channel.created: new channel appended to the list
 * - channel.updated: channel replaced in-place
 * - channel.deleted: channel removed from the list
 *
 * WHY direct cache update instead of invalidation: avoids a network
 * round-trip per event, keeping the channel sidebar feel instant.
 *
 * WHY no serverId filter: SSE delivers events for ALL servers the user
 * belongs to. Filtering by selectedServerId caused missed updates — when the
 * user viewed server Y, channel events for server X were silently dropped.
 * Combined with the 5-min global staleTime, navigating back to X showed a
 * stale channel list. Same fix as useRealtimeMembers().
 *
 * NOTE: The cache shape is ChannelResponse[] (not ChannelListResponse),
 * because useChannels returns `data.items` in its queryFn.
 */
export function useRealtimeChannels() {
  const queryClient = useQueryClient()
  const currentUserId = useAuthStore((s) => s.user?.id ?? '')

  const handleChannelCreated = useCallback(
    (payload: unknown) => {
      const parsed = channelEventSchema.safeParse(payload)
      if (!parsed.success) {
        logger.error('Malformed channel.created SSE payload', {
          error: parsed.error.message,
        })
        return
      }

      const eventServerId = parsed.data.serverId
      const channel = toChannelResponse(parsed.data.channel, eventServerId)

      queryClient.setQueryData<ChannelResponse[]>(
        queryKeys.channels.byServer(eventServerId),
        (old) => {
          if (!old) return undefined

          // WHY: Deduplicate — skip if channel already exists in the list.
          const alreadyExists = old.some((c) => c.id === channel.id)
          if (alreadyExists) return old

          return [...old, channel]
        },
      )
    },
    [queryClient],
  )

  const handleChannelUpdated = useCallback(
    (payload: unknown) => {
      const parsed = channelEventSchema.safeParse(payload)
      if (!parsed.success) {
        logger.error('Malformed channel.updated SSE payload', {
          error: parsed.error.message,
        })
        return
      }

      const eventServerId = parsed.data.serverId
      const channel = toChannelResponse(parsed.data.channel, eventServerId)

      queryClient.setQueryData<ChannelResponse[]>(
        queryKeys.channels.byServer(eventServerId),
        (old) => {
          if (!old) return undefined
          // WHY upsert (not map-only): a private→public toggle delivers
          // channel.updated to members who never had the channel in their
          // cache (it was hidden while private) — the now-public channel must
          // APPEAR in their sidebar, not be silently dropped.
          const exists = old.some((c) => c.id === channel.id)
          if (!exists) return [...old, channel]
          return old.map((c) => (c.id === channel.id ? channel : c))
        },
      )
    },
    [queryClient],
  )

  const handleChannelDeleted = useCallback(
    (payload: unknown) => {
      const parsed = channelDeletedSchema.safeParse(payload)
      if (!parsed.success) {
        logger.error('Malformed channel.deleted SSE payload', {
          error: parsed.error.message,
        })
        return
      }

      const eventServerId = parsed.data.serverId

      queryClient.setQueryData<ChannelResponse[]>(
        queryKeys.channels.byServer(eventServerId),
        (old) => {
          if (!old) return undefined

          const filtered = old.filter((c) => c.id !== parsed.data.channelId)
          // WHY: If no channel was actually removed, return old to avoid re-render.
          if (filtered.length === old.length) return old

          return filtered
        },
      )
    },
    [queryClient],
  )

  const handleChannelAccessUpdated = useCallback(
    (payload: unknown) => {
      const parsed = channelAccessUpdatedSchema.safeParse(payload)
      if (!parsed.success) {
        logger.warn('Malformed channel.access_updated SSE payload', {
          error: parsed.error.message,
        })
        return
      }

      const { serverId, channelId, authorizedRoles } = parsed.data
      const channelsKey = queryKeys.channels.byServer(serverId)
      const present =
        queryClient.getQueryData<ChannelResponse[]>(channelsKey)?.some((c) => c.id === channelId) ??
        false

      // Resolve my role in that server from the members cache. When it is
      // unknown (cache cold), we can't decide locally — invalidate and let the
      // access-gated list_channels refetch be the authority (it never returns a
      // channel the caller cannot see, so there is no leak either way).
      const members = queryClient.getQueryData<MemberListResponse>(
        queryKeys.servers.members(serverId),
      )
      const self = members?.items.find((m) => m.userId === currentUserId)
      const myRole: MemberRole | null = self === undefined ? null : getMemberRole(self)

      if (myRole === null) {
        queryClient.invalidateQueries({ queryKey: channelsKey })
        return
      }

      // Admin/owner always qualify; others need their role in the granted set.
      const qualifies =
        myRole === 'admin' || myRole === 'owner' || authorizedRoles.some((r) => r === myRole)

      if (qualifies) {
        // Newly (or still) granted: if the channel isn't in the cache yet, the
        // gated refetch pulls it in with its real name/topic — no leak.
        if (!present) {
          queryClient.invalidateQueries({ queryKey: channelsKey })
        }
      } else if (present) {
        // Access revoked: evict it immediately (mirror channel.deleted).
        queryClient.setQueryData<ChannelResponse[]>(channelsKey, (old) => {
          if (!old) return undefined
          const filtered = old.filter((c) => c.id !== channelId)
          if (filtered.length === old.length) return old
          return filtered
        })
      }
    },
    [queryClient, currentUserId],
  )

  const handleMemberRoleUpdated = useCallback(
    (payload: unknown) => {
      const parsed = memberRoleUpdatedSchema.safeParse(payload)
      if (!parsed.success) {
        logger.warn('Malformed member.role_updated SSE payload (channels)', {
          error: parsed.error.message,
        })
        return
      }

      // WHY only MY role change: another member's promotion never changes
      // which channels I can see.
      if (parsed.data.member.userId !== currentUserId) return

      // WHY invalidate (not setQueryData): the client does not hold per-channel
      // grant sets, so it cannot decide locally which private channels the new
      // role reveals or hides. The access-gated list_channels refetch is the
      // authority — same posture as the cold-cache branch of
      // channel.access_updated above. Both directions are covered: a promotion
      // pulls newly visible channels in, a demotion drops revoked ones.
      queryClient.invalidateQueries({
        queryKey: queryKeys.channels.byServer(parsed.data.serverId),
      })
    },
    [queryClient, currentUserId],
  )

  useServerEvent('channel.created', handleChannelCreated)
  useServerEvent('channel.updated', handleChannelUpdated)
  useServerEvent('channel.deleted', handleChannelDeleted)
  useServerEvent('channel.access_updated', handleChannelAccessUpdated)
  useServerEvent('member.role_updated', handleMemberRoleUpdated)
}
