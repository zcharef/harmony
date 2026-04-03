import { useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { z } from 'zod'
import { useServerEvent } from '@/hooks/use-server-event'
import type { ChannelResponse } from '@/lib/api'
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
  channelType: z.enum(['text', 'voice']),
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
 * Subscribes to SSE channel events for a given server and updates
 * the TanStack Query cache on:
 * - channel.created: new channel appended to the list
 * - channel.updated: channel replaced in-place
 * - channel.deleted: channel removed from the list
 *
 * WHY direct cache update instead of invalidation: avoids a network
 * round-trip per event, keeping the channel sidebar feel instant.
 *
 * NOTE: The cache shape is ChannelResponse[] (not ChannelListResponse),
 * because useChannels returns `data.items` in its queryFn.
 */
export function useRealtimeChannels(serverId: string) {
  const queryClient = useQueryClient()

  const handleChannelCreated = useCallback(
    (payload: unknown) => {
      if (serverId.length === 0) return

      const parsed = channelEventSchema.safeParse(payload)
      if (!parsed.success) {
        logger.error('Malformed channel.created SSE payload', {
          serverId,
          error: parsed.error.message,
        })
        return
      }

      if (parsed.data.serverId !== serverId) return

      const channel = toChannelResponse(parsed.data.channel, parsed.data.serverId)

      queryClient.setQueryData<ChannelResponse[]>(queryKeys.channels.byServer(serverId), (old) => {
        if (!old) return undefined

        // WHY: Deduplicate — skip if channel already exists in the list.
        const alreadyExists = old.some((c) => c.id === channel.id)
        if (alreadyExists) return old

        return [...old, channel]
      })
    },
    [serverId, queryClient],
  )

  const handleChannelUpdated = useCallback(
    (payload: unknown) => {
      if (serverId.length === 0) return

      const parsed = channelEventSchema.safeParse(payload)
      if (!parsed.success) {
        logger.error('Malformed channel.updated SSE payload', {
          serverId,
          error: parsed.error.message,
        })
        return
      }

      if (parsed.data.serverId !== serverId) return

      const channel = toChannelResponse(parsed.data.channel, parsed.data.serverId)

      queryClient.setQueryData<ChannelResponse[]>(queryKeys.channels.byServer(serverId), (old) => {
        if (!old) return undefined
        return old.map((c) => (c.id === channel.id ? channel : c))
      })
    },
    [serverId, queryClient],
  )

  const handleChannelDeleted = useCallback(
    (payload: unknown) => {
      if (serverId.length === 0) return

      const parsed = channelDeletedSchema.safeParse(payload)
      if (!parsed.success) {
        logger.error('Malformed channel.deleted SSE payload', {
          serverId,
          error: parsed.error.message,
        })
        return
      }

      if (parsed.data.serverId !== serverId) return

      queryClient.setQueryData<ChannelResponse[]>(queryKeys.channels.byServer(serverId), (old) => {
        if (!old) return undefined

        const filtered = old.filter((c) => c.id !== parsed.data.channelId)
        // WHY: If no channel was actually removed, return old to avoid re-render.
        if (filtered.length === old.length) return old

        return filtered
      })
    },
    [serverId, queryClient],
  )

  useServerEvent(serverId.length > 0 ? 'channel.created' : null, handleChannelCreated)
  useServerEvent(serverId.length > 0 ? 'channel.updated' : null, handleChannelUpdated)
  useServerEvent(serverId.length > 0 ? 'channel.deleted' : null, handleChannelDeleted)
}
