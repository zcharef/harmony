import { useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { z } from 'zod'
import { useServerEvent } from '@/hooks/use-server-event'
import type { ChannelResponse } from '@/lib/api'
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

  useServerEvent('channel.created', handleChannelCreated)
  useServerEvent('channel.updated', handleChannelUpdated)
  useServerEvent('channel.deleted', handleChannelDeleted)
}
