import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { type EmojiResponse, listServerEmojis } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { buildEmojiMap } from '../lib/emoji-token'

/**
 * Fetches a server's custom emoji. Enabled only when `serverId` is set. The
 * result feeds the settings grid, the composer custom category, and the message
 * render map — one query, shared across sites (TanStack dedupes by key).
 */
export function useServerEmojis(serverId: string | null) {
  return useQuery({
    queryKey: queryKeys.servers.emojis(serverId ?? ''),
    queryFn: async () => {
      // WHY non-null: `enabled` guards this — the queryFn never runs when null.
      const { data } = await listServerEmojis({
        path: { id: serverId ?? '' },
        throwOnError: true,
      })
      return data
    },
    enabled: serverId !== null && serverId.length > 0,
  })
}

/**
 * O(1) `name → emoji` map for the render sites (message bodies, reaction pills).
 * Empty while the query is pending/absent ⇒ `:name:` tokens stay literal, then
 * re-render on cache fill (§1 loading state).
 */
export function useServerEmojiMap(serverId: string | null): Map<string, EmojiResponse> {
  const { data } = useServerEmojis(serverId)
  return useMemo(() => buildEmojiMap(data?.items ?? []), [data])
}
