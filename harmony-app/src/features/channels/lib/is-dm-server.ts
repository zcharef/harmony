import type { QueryClient } from '@tanstack/react-query'
import type { DmListItem } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'

/**
 * ONE shared DM classifier — the sound, mentions and desktop-notification
 * pipelines all import this; no synonymous copies.
 *
 * DM servers are matched against the DMs cache (queryKeys.dms.list()), where
 * each DmListItem carries a serverId. useDms() is mounted in MainLayout, so
 * the cache is populated regardless of the current view.
 */

/**
 * Tri-state DM flag: `undefined` = DMs cache not loaded yet (startup/refetch
 * race) — callers that must distinguish "not a DM" from "unknown" (the
 * notification policy's fail-open 'unknown' class) use this.
 */
export function dmServerFlag(serverId: string, queryClient: QueryClient): boolean | undefined {
  const dms = queryClient.getQueryData<DmListItem[]>(queryKeys.dms.list())
  if (dms === undefined) return undefined
  return dms.some((dm) => dm.serverId === serverId)
}

/** Boolean convenience wrapper: unknown counts as "not a DM". */
export function isDmServer(serverId: string, queryClient: QueryClient): boolean {
  return dmServerFlag(serverId, queryClient) === true
}
