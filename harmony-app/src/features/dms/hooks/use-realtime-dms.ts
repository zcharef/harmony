import { useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { useServerEvent } from '@/hooks/use-server-event'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'

/**
 * Subscribes to SSE dm.created events and invalidates the DM list cache.
 *
 * WHY invalidation instead of direct cache mutation: The DmListItem shape
 * includes `lastMessage` and `recipient` data that differs significantly
 * from the SSE DmPayload (which has otherUserId/otherUsername but not the
 * full DmLastMessageResponse). Invalidation is simpler and correct — the
 * DM list is a short list so the refetch cost is negligible.
 *
 * WHY no Zod: We only check that the event fired, then invalidate.
 * The payload content is not used for cache mutation, so validation
 * adds no safety benefit here.
 */
export function useRealtimeDms() {
  const queryClient = useQueryClient()

  const handleDmCreated = useCallback(
    (payload: unknown) => {
      logger.info('dm.created SSE event received, invalidating DM list cache', {
        hasPayload: payload !== null && payload !== undefined,
      })

      queryClient.invalidateQueries({ queryKey: queryKeys.dms.list() })
    },
    [queryClient],
  )

  useServerEvent('dm.created', handleDmCreated)
}
