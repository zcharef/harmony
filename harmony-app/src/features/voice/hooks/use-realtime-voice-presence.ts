import { useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { z } from 'zod'
import { useServerEvent } from '@/hooks/use-server-event'
import type { VoiceParticipantResponse } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'

/**
 * WHY local schema (not imported from event-types.ts): useFetchSSE already
 * validates the full discriminated union via serverEventSchema. This validates
 * only the subset needed for cross-channel eviction (channelId, userId, action).
 * Mirrors the local-schema pattern in use-realtime-voice.ts.
 */
const voiceJoinedSchema = z.object({
  channelId: z.string().uuid(),
  userId: z.string().uuid(),
  action: z.string(),
})

/**
 * WHY (ghost presence on channel switch): A voice channel switch calls
 * joinVoice(B) with no explicit leave of A. A client whose VoiceParticipantList
 * for channel A is not mounted (viewing a DM, or another server) never runs the
 * per-channel useRealtimeVoice(A) subscription, so it never processes the
 * one-shot Left(A) SSE — and the participants(A) cache keeps serving the user
 * as a ghost in A until it refetches. The server is correct (a user holds at
 * most one voice session); the staleness is purely client-side.
 *
 * Fix: on any Joined(userId, B) event, evict userId from EVERY OTHER voice
 * channel's participant cache. Because a user is in at most one voice channel,
 * this makes old-channel removal durable regardless of which lists are mounted.
 * It complements the per-channel useRealtimeVoice(B), which adds the user to B.
 *
 * Mounted once in MainLayout so it survives view switches (CLAUDE.md §4.6) and
 * catches joins for servers/channels whose lists are not currently rendered.
 */
export function useRealtimeVoicePresence() {
  const queryClient = useQueryClient()

  const handleVoiceStateUpdate = useCallback(
    (payload: unknown) => {
      const parsed = voiceJoinedSchema.safeParse(payload)
      if (!parsed.success) return
      if (parsed.data.action !== 'joined') return

      const { userId, channelId: joinedChannelId } = parsed.data

      // WHY: queryKeys.voice.all (['voice']) prefix-matches every voice query;
      // narrow to participants(<channelId>) and skip the channel just joined.
      for (const query of queryClient.getQueryCache().findAll({ queryKey: queryKeys.voice.all })) {
        const key = query.queryKey
        if (key[1] !== 'participants') continue
        const cachedChannelId = key[2]
        if (typeof cachedChannelId !== 'string') continue
        if (cachedChannelId === joinedChannelId) continue

        queryClient.setQueryData<VoiceParticipantResponse[]>(key, (old) => {
          // WHY: Return the same reference when the user is absent so we do not
          // trigger a needless re-render of an unaffected channel's list.
          if (old === undefined || !old.some((p) => p.userId === userId)) return old
          return old.filter((p) => p.userId !== userId)
        })
      }
    },
    [queryClient],
  )

  useServerEvent('voice.state_update', handleVoiceStateUpdate)
}
