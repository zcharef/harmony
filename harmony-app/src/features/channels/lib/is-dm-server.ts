import type { QueryClient } from '@tanstack/react-query'
import type { DmListItem } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'

/**
 * WHY: DM servers are NOT in the servers list cache (queryKeys.servers.list()).
 * They live in the DMs cache (queryKeys.dms.list()) where each DmListItem has
 * a serverId. Matching against this cache is the only reliable way to detect
 * whether an incoming message belongs to a DM conversation.
 *
 * ONE shared implementation (extracted from use-notification-sound.ts) — the
 * sound, mentions and (later) desktop-notification hooks all import this;
 * no synonymous copies.
 */
export function isDmServer(serverId: string, queryClient: QueryClient): boolean {
  const dms = queryClient.getQueryData<DmListItem[]>(queryKeys.dms.list())
  if (dms === undefined) return false
  return dms.some((dm) => dm.serverId === serverId)
}
