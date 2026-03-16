import { useInfiniteQuery } from '@tanstack/react-query'
import type { MessageListResponse } from '@/lib/api'
import { listMessages } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'

/**
 * WHY useInfiniteQuery: Messages load newest-first from the API (ORDER BY created_at DESC).
 * Scrolling up fetches the next "page" of older messages via the `before` cursor.
 * TanStack Query manages the page cache automatically.
 *
 * WHY getNextPageParam reads nextCursor: The API returns nextCursor when more
 * messages exist (ADR-036 cursor-based pagination). Returning undefined stops
 * infinite fetching.
 */
export function useMessages(channelId: string | null) {
  return useInfiniteQuery({
    queryKey: queryKeys.messages.byChannel(channelId ?? ''),
    queryFn: async ({ pageParam }) => {
      if (channelId === null) throw new Error('channelId is required')
      const { data } = await listMessages({
        path: { id: channelId },
        query: { before: pageParam, limit: 50 },
        throwOnError: true,
      })
      return data
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage: MessageListResponse) => lastPage.nextCursor ?? undefined,
    enabled: channelId !== null,
  })
}
