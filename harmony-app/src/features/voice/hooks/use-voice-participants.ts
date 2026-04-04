import { useQuery } from '@tanstack/react-query'
import { listVoiceParticipants } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'

/**
 * WHY: Wraps listVoiceParticipants SDK call in TanStack Query.
 * Fetches current voice participants for a channel. Disabled when
 * no channelId is provided (avoids firing requests before channel selection).
 */
export function useVoiceParticipants(channelId: string | null) {
  return useQuery({
    queryKey: queryKeys.voice.participants(channelId ?? ''),
    queryFn: async () => {
      // WHY: `enabled` guard ensures channelId is non-null when queryFn runs
      if (channelId === null) throw new Error('channelId is required')
      const { data } = await listVoiceParticipants({
        path: { id: channelId },
        throwOnError: true,
      })
      return data.items
    },
    enabled: channelId !== null,
  })
}
