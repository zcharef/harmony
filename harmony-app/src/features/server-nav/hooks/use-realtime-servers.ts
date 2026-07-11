import { useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { z } from 'zod'
import { useServerEvent } from '@/hooks/use-server-event'
import type { ServerResponse } from '@/lib/api'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'

/**
 * WHY local schema (not imported from event-types.ts): useEventSource already
 * validates the full discriminated union. This local schema validates only
 * the subset needed for cache mutation, mirroring use-realtime-channels.ts.
 */
const serverUpdatedSchema = z.object({
  server: z.object({
    id: z.string(),
    name: z.string(),
    iconUrl: z.string().nullable(),
    ownerId: z.string(),
    // WHY optional WITHOUT default: rollout-safe — an older API instance
    // publishes server.updated without the discovery keys. An absent key must
    // preserve the cached value, not clobber it with a default.
    discoverable: z.boolean().optional(),
    discoveryCategory: z.string().nullable().optional(),
    discoveryDescription: z.string().nullable().optional(),
  }),
})

/**
 * Subscribes to `server.updated` and patches the servers list cache in place
 * (rename, icon, ownership transfer, discovery settings) so the rail, header
 * and server-settings screens rehydrate live without a refetch.
 *
 * NOTE: The cache shape is ServerResponse[] (not ServerListResponse),
 * because useServers returns `data.items` in its queryFn (use-servers.ts).
 */
export function useRealtimeServers() {
  const queryClient = useQueryClient()

  const handleServerUpdated = useCallback(
    (payload: unknown) => {
      const parsed = serverUpdatedSchema.safeParse(payload)
      if (!parsed.success) {
        logger.error('Malformed server.updated SSE payload', {
          error: parsed.error.message,
        })
        return
      }

      const { server } = parsed.data
      queryClient.setQueryData<ServerResponse[]>(queryKeys.servers.list(), (old) => {
        if (old === undefined) return undefined
        return old.map((s) =>
          s.id === server.id
            ? {
                ...s,
                name: server.name,
                iconUrl: server.iconUrl,
                ownerId: server.ownerId,
                // WHY presence checks: an absent key (older API instance during
                // rollout) must not overwrite the cached value — only a payload
                // that actually carries the field updates it. `null` IS carried
                // for a cleared category/description and correctly overwrites.
                discoverable:
                  server.discoverable !== undefined ? server.discoverable : s.discoverable,
                discoveryCategory:
                  server.discoveryCategory !== undefined
                    ? server.discoveryCategory
                    : (s.discoveryCategory ?? null),
                discoveryDescription:
                  server.discoveryDescription !== undefined
                    ? server.discoveryDescription
                    : (s.discoveryDescription ?? null),
              }
            : s,
        )
      })
    },
    [queryClient],
  )

  useServerEvent('server.updated', handleServerUpdated)
}
