import { useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { z } from 'zod'
import { useServerEvent } from '@/hooks/use-server-event'
import type { ModerationSettingsResponse } from '@/lib/api'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'

/**
 * WHY local schema: useEventSource already validates the full discriminated union.
 * This local schema validates only the subset needed for cache mutation.
 */
const moderationSettingsEventSchema = z.object({
  serverId: z.string(),
  categories: z.record(z.string(), z.boolean()),
})

/**
 * Subscribes to `server.moderation_settings_updated` SSE events and updates
 * the TanStack Query cache directly (no refetch).
 */
export function useRealtimeModerationSettings(serverId: string | null) {
  const queryClient = useQueryClient()

  const handleSettingsUpdated = useCallback(
    (payload: unknown) => {
      if (serverId === null || serverId.length === 0) return

      const parsed = moderationSettingsEventSchema.safeParse(payload)
      if (!parsed.success) {
        logger.error('Malformed server.moderation_settings_updated SSE payload', {
          serverId,
          error: parsed.error.message,
        })
        return
      }

      if (parsed.data.serverId !== serverId) return

      queryClient.setQueryData<ModerationSettingsResponse>(
        queryKeys.servers.moderation(serverId),
        (old) => {
          if (!old) return undefined
          return { ...old, categories: parsed.data.categories }
        },
      )
    },
    [serverId, queryClient],
  )

  useServerEvent(
    serverId !== null && serverId.length > 0 ? 'server.moderation_settings_updated' : null,
    handleSettingsUpdated,
  )
}
