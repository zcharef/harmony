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
    // WHY (ghost presence): the app-wide default staleTime is 5min. A remounted
    // VoiceParticipantList / VoiceChannelOccupancy would otherwise serve a
    // 5-min-stale roster (a user who already left still shown). staleTime:0
    // makes a remount refetch truth; between mounts the SSE cache-patching
    // (useRealtimeVoice + useRealtimeVoicePresence) keeps the roster live, so
    // this does not cause a refetch storm.
    staleTime: 0,
  })
}
