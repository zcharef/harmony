import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef } from 'react'
import { z } from 'zod'
import { useServerEvent } from '@/hooks/use-server-event'
import type { VoiceParticipantResponse } from '@/lib/api'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'
import { playVoiceSound } from '../lib/voice-sounds'
import { useVoiceConnectionStore } from '../stores/voice-connection-store'

/** WHY: Consensus review recommended 500ms debounce on SSE-triggered cache
 * mutations to prevent rapid-fire TanStack Query updates during participant
 * churn (multiple joins/leaves in quick succession). */
const DEBOUNCE_MS = 500

/**
 * WHY local schema (not imported from event-types.ts): useEventSource already
 * validates the full discriminated union via serverEventSchema. This local schema
 * validates only the subset of fields needed for cache mutation (channelId, userId,
 * action), and keeps the handler self-contained. Same pattern as
 * use-realtime-channels.ts.
 */
const voiceStateUpdateSchema = z.object({
  serverId: z.string(),
  channelId: z.string().uuid(),
  userId: z.string().uuid(),
  action: z.enum(['joined', 'left']),
  displayName: z.string(),
})

type VoiceStateUpdate = z.infer<typeof voiceStateUpdateSchema>

/**
 * Applies accumulated voice state updates to the TanStack Query cache in a
 * single batch. Processes events in order so sequential join+leave for the
 * same user collapses correctly.
 */
function applyJoin(
  list: VoiceParticipantResponse[],
  event: VoiceStateUpdate,
): VoiceParticipantResponse[] {
  if (list.some((p) => p.userId === event.userId)) return list
  return [
    ...list,
    {
      channelId: event.channelId,
      userId: event.userId,
      displayName: event.displayName,
      joinedAt: new Date().toISOString(),
    },
  ]
}

function applyLeave(
  list: VoiceParticipantResponse[],
  event: VoiceStateUpdate,
): VoiceParticipantResponse[] {
  const filtered = list.filter((p) => p.userId !== event.userId)
  return filtered.length !== list.length ? filtered : list
}

function applyBatch(
  events: VoiceStateUpdate[],
  channelId: string,
  queryClient: ReturnType<typeof useQueryClient>,
) {
  queryClient.setQueryData<VoiceParticipantResponse[]>(
    queryKeys.voice.participants(channelId),
    (old) => {
      // WHY: When the cache hasn't been populated yet (e.g. SSE event arrives
      // before the initial REST fetch completes), start from an empty array
      // instead of silently dropping the event.
      const baseline = old ?? []

      let next = baseline
      for (const event of events) {
        next = event.action === 'joined' ? applyJoin(next, event) : applyLeave(next, event)
      }

      // WHY: If nothing changed after processing all events, return baseline
      // reference to avoid unnecessary re-renders.
      return next === baseline ? baseline : next
    },
  )
}

/**
 * Subscribes to SSE voice.state_update events and updates the TanStack Query
 * cache for voice participants on:
 * - joined: new participant appended to the list
 * - left: participant removed from the list
 *
 * WHY direct cache update instead of invalidation: avoids a network round-trip
 * per event, keeping the voice participant list feel instant.
 *
 * WHY debounce: During participant churn (multiple joins/leaves in quick
 * succession), individual cache mutations cause rapid re-renders. Accumulating
 * events for 500ms and batch-applying them reduces TanStack Query cache updates
 * to at most 2/second.
 *
 * NOTE: The cache shape is VoiceParticipantResponse[] (not VoiceParticipantsResponse),
 * because useVoiceParticipants returns `data.items` in its queryFn.
 * See use-voice-participants.ts:L20.
 */
export function useRealtimeVoice(channelId: string) {
  const queryClient = useQueryClient()

  // WHY refs: The debounce buffer and timer must survive across renders
  // without triggering re-renders themselves.
  const bufferRef = useRef<VoiceStateUpdate[]>([])
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // WHY: Flush pending events on unmount so no updates are silently lost.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      if (bufferRef.current.length > 0) {
        applyBatch(bufferRef.current, channelId, queryClient)
        bufferRef.current = []
      }
    }
  }, [channelId, queryClient])

  const handleVoiceStateUpdate = useCallback(
    (payload: unknown) => {
      if (channelId.length === 0) return

      const parsed = voiceStateUpdateSchema.safeParse(payload)
      if (!parsed.success) {
        // WHY warn not error: Malformed SSE payload is an external data issue,
        // not an application error. The event stream is from the server — a
        // schema mismatch is a warn-level concern (e.g., version skew).
        logger.warn('Malformed voice.state_update SSE payload', {
          channelId,
          error: parsed.error.message,
        })
        return
      }

      if (parsed.data.channelId !== channelId) return

      // WHY: Play sound only for OTHER users joining/leaving our active voice
      // channel. Self-actions already trigger sounds in use-voice-connection.ts.
      // getState() is a sync Zustand read — safe inside a callback.
      // WHY status guard: During self-join, the SSE event can arrive before
      // storeConnect completes (status is still 'connecting', room is null).
      // Without this check, room?.localParticipant.identity is undefined and
      // the self-filter fails, causing a double-play with use-voice-connection.
      const voiceState = useVoiceConnectionStore.getState()
      if (
        voiceState.status === 'connected' &&
        voiceState.currentChannelId === channelId &&
        voiceState.room?.localParticipant.identity !== parsed.data.userId
      ) {
        playVoiceSound(parsed.data.action === 'joined' ? 'join' : 'leave')
      }

      // WHY: Accumulate events and flush after DEBOUNCE_MS to batch cache
      // mutations during participant churn.
      bufferRef.current.push(parsed.data)

      if (timerRef.current === null) {
        timerRef.current = setTimeout(() => {
          timerRef.current = null
          const events = bufferRef.current
          bufferRef.current = []
          applyBatch(events, channelId, queryClient)
        }, DEBOUNCE_MS)
      }
    },
    [channelId, queryClient],
  )

  useServerEvent(channelId.length > 0 ? 'voice.state_update' : null, handleVoiceStateUpdate)
}
