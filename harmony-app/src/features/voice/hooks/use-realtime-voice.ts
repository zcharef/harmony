import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef } from 'react'
import { z } from 'zod'
import { useServerEvent } from '@/hooks/use-server-event'
import type { VoiceParticipantResponse } from '@/lib/api'
import { zVoiceAction } from '@/lib/api/zod.gen'
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
  action: zVoiceAction,
  displayName: z.string(),
  isMuted: z.boolean().optional(),
  isDeafened: z.boolean().optional(),
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
      isMuted: false,
      isDeafened: false,
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

/** WHY extracted: Keeps applyMuteState map callback under Biome's cognitive
 * complexity limit of 15. Uses authoritative booleans from SSE payload when
 * present, falls back to action-based inference for backward compat. */
function resolveMuted(event: VoiceStateUpdate, current: boolean): boolean {
  if (event.isMuted !== undefined) return event.isMuted
  if (event.action === 'muted') return true
  if (event.action === 'unmuted') return false
  return current
}

function resolveDeafened(event: VoiceStateUpdate, current: boolean): boolean {
  if (event.isDeafened !== undefined) return event.isDeafened
  if (event.action === 'deafened') return true
  if (event.action === 'undeafened') return false
  return current
}

function applyMuteState(
  list: VoiceParticipantResponse[],
  event: VoiceStateUpdate,
): VoiceParticipantResponse[] {
  let found = false
  const result = list.map((p) => {
    if (p.userId !== event.userId) return p
    found = true
    return {
      ...p,
      isMuted: resolveMuted(event, p.isMuted),
      isDeafened: resolveDeafened(event, p.isDeafened),
    }
  })
  if (!found) {
    logger.warn('voice_mute_state_participant_not_found', {
      userId: event.userId,
      action: event.action,
    })
  }
  return result
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
        if (event.action === 'joined') {
          next = applyJoin(next, event)
        } else if (event.action === 'left') {
          next = applyLeave(next, event)
        } else {
          next = applyMuteState(next, event)
        }
      }

      // WHY: If nothing changed after processing all events, return baseline
      // reference to avoid unnecessary re-renders.
      return next === baseline ? baseline : next
    },
  )
}

/** WHY extracted: Keeps handleVoiceStateUpdate under Biome's cognitive complexity
 * limit of 15. Checks if a "left" event targets the locally connected user. If
 * so, the event is ignored — the heartbeat 404 → force-disconnect handles
 * legitimate disconnects cleanly, preventing the jarring "name disappears while
 * still talking" symptom caused by sweep race conditions. */
function isSelfLeftWhileConnected(event: VoiceStateUpdate): boolean {
  if (event.action !== 'left') return false
  const { status, room } = useVoiceConnectionStore.getState()
  // WHY 'reconnecting': During ICE restart the heartbeat is still alive
  // (use-voice-connection.ts:362), so the server session is valid. A sweep-
  // fired "left" event during reconnecting is just as spurious as during
  // connected — let the heartbeat 404 handle legitimate disconnects.
  return (
    (status === 'connected' || status === 'reconnecting') &&
    room?.localParticipant.identity === event.userId
  )
}

/** WHY extracted: Keeps handleVoiceStateUpdate under Biome's cognitive complexity
 * limit of 15. Plays join/leave sound only for OTHER users in the locally
 * connected voice channel. Self-actions already trigger sounds in
 * use-voice-connection.ts. */
function maybePlayParticipantSound(event: VoiceStateUpdate, channelId: string): void {
  if (event.action !== 'joined' && event.action !== 'left') return
  const voiceState = useVoiceConnectionStore.getState()
  if (
    voiceState.status === 'connected' &&
    voiceState.currentChannelId === channelId &&
    voiceState.room?.localParticipant.identity !== event.userId
  ) {
    playVoiceSound(event.action === 'joined' ? 'join' : 'leave')
  }
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

      maybePlayParticipantSound(parsed.data, channelId)

      // WHY: See isSelfLeftWhileConnected doc — prevents sweep race from
      // removing our name while we can still talk. Self-leave is handled by
      // direct cache eviction in handleLeaveVoice.
      if (isSelfLeftWhileConnected(parsed.data)) {
        logger.info('voice_self_left_event_ignored', {
          channelId,
          userId: parsed.data.userId,
        })
        return
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
