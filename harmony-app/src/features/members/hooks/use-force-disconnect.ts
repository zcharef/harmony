import { useQueryClient } from '@tanstack/react-query'
import i18n from 'i18next'
import { useCallback } from 'react'
import { z } from 'zod'
import { useVoiceConnectionStore } from '@/features/voice'
import { useServerEvent } from '@/hooks/use-server-event'
import type { ServerResponse } from '@/lib/api'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'
import { toast } from '@/lib/toast'

/**
 * WHY Zod: SSE payloads are external data from an event stream. CLAUDE.md 1.2
 * mandates Zod validation for all external data. Without it, a malformed
 * forceDisconnect event could silently corrupt the handler.
 */
const forceDisconnectSchema = z.object({
  serverId: z.string(),
  targetUserId: z.string(),
  reason: z.string(),
})

/**
 * WHY extracted: Keeps the main handler below Biome's cognitive complexity
 * limit (15) by isolating the toast reason-mapping logic.
 */
function notifyRemoval(reason: string, serverName: string | undefined): void {
  // WHY: "left" means the user voluntarily left — they already know,
  // so skip the toast. Only notify for involuntary removals.
  if (reason === 'left') return

  const titleKey =
    reason === 'banned'
      ? 'members:bannedTitle'
      : reason === 'kicked'
        ? 'members:kickedTitle'
        : 'members:removedTitle'

  const descriptionKey =
    serverName !== undefined
      ? reason === 'banned'
        ? 'members:bannedFromServer'
        : reason === 'kicked'
          ? 'members:kickedFromServer'
          : 'members:removedFromServerNamed'
      : 'members:removedFromServer'

  toast.error(i18n.t(titleKey), {
    description: i18n.t(descriptionKey, { serverName }),
  })
}

/**
 * Subscribes to `force.disconnect` SSE events and, when the current user is
 * the target, invalidates caches and clears the server selection so the UI
 * navigates away from the kicked/banned server.
 *
 * WHY a separate hook (not inside useRealtimeMembers): useRealtimeMembers is
 * mounted inside MemberList, which only renders for the currently viewed server.
 * A force disconnect can target any server the user belongs to, so this hook
 * must be mounted at a global level (MainLayout) to guarantee it always runs.
 *
 * WHY cache invalidation instead of direct state mutation: MainLayout already
 * has useServerAutoSelect (main-layout.tsx:127-135) which resets selection when
 * the selected server disappears from the cache. Invalidating the server list
 * triggers a refetch (the kicked server will be absent), and the auto-select
 * logic handles the rest. This avoids duplicating navigation logic.
 */
export function useForceDisconnect(
  currentUserId: string | null,
  selectedServerId: string | null,
  setSelectedServerId: (id: string | null) => void,
  setSelectedChannelId: (id: string | null) => void,
) {
  const queryClient = useQueryClient()

  const handleForceDisconnect = useCallback(
    (payload: unknown) => {
      if (currentUserId === null) return

      const parsed = forceDisconnectSchema.safeParse(payload)
      if (!parsed.success) {
        logger.error('Malformed force.disconnect SSE payload', {
          error: parsed.error.message,
        })
        return
      }

      // WHY explicit ===: Only act when this user is the target (ADR philosophy:
      // explicit comparisons, not truthiness).
      if (parsed.data.targetUserId !== currentUserId) return

      const { serverId, reason } = parsed.data

      logger.info('force_disconnect_received', { serverId, reason })

      // WHY: Read server name from cache BEFORE invalidation wipes it.
      // invalidateQueries is async — the stale data is still readable here.
      const cachedServers = queryClient.getQueryData<ServerResponse[]>(queryKeys.servers.list())
      const serverName = cachedServers?.find((s) => s.id === serverId)?.name

      // WHY: Invalidate server list so the kicked server disappears from the
      // sidebar. Also invalidate members for that server to clean stale cache.
      queryClient.invalidateQueries({ queryKey: queryKeys.servers.all })
      queryClient.removeQueries({ queryKey: queryKeys.servers.members(serverId) })
      queryClient.removeQueries({ queryKey: queryKeys.servers.channels(serverId) })

      // WHY (P0-2): If the banned/kicked user is currently in a voice channel
      // on this server, tear down the LiveKit room immediately. Without this,
      // the user stays connected up to 2h (token TTL) after being banned.
      const voiceState = useVoiceConnectionStore.getState()
      if (voiceState.currentServerId === serverId) {
        voiceState.disconnect().catch((err: unknown) => {
          logger.warn('voice_force_disconnect_failed', {
            error: err instanceof Error ? err.message : String(err),
            serverId,
          })
        })
      }

      // WHY: If the user is currently viewing the kicked server, clear selection
      // immediately. This gives instant feedback rather than waiting for the
      // cache refetch + useServerAutoSelect cycle.
      if (selectedServerId === serverId) {
        setSelectedServerId(null)
        setSelectedChannelId(null)
      }

      notifyRemoval(reason, serverName)
    },
    [currentUserId, selectedServerId, queryClient, setSelectedServerId, setSelectedChannelId],
  )

  useServerEvent(currentUserId !== null ? 'force.disconnect' : null, handleForceDisconnect)
}
