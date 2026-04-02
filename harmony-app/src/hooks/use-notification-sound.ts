import { type QueryClient, useQueryClient } from '@tanstack/react-query'
import { useCallback, useRef } from 'react'
import { z } from 'zod'
import type { DmListItem, NotificationSettingsResponse } from '@/lib/api'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'
import { useServerEvent } from './use-server-event'

/**
 * WHY 1s (not 5s like desktop notifications): Sound is less intrusive than
 * a native notification popup, so a shorter cooldown feels responsive without
 * being annoying. Prevents audio spam on rapid-fire messages.
 */
const COOLDOWN_MS = 1_000

const soundEventSchema = z.object({
  senderId: z.string(),
  serverId: z.string(),
  channelId: z.string(),
  message: z.object({
    messageType: z.string(),
  }),
})

type SoundEvent = z.infer<typeof soundEventSchema>

// ── Extracted helpers (keep handler under Biome cognitive complexity limit) ──

/**
 * WHY: Suppresses sound when the user is already viewing the source channel.
 * No focus check needed — if the channel is selected, the user sees the
 * message in real-time via the chat area regardless of window focus state.
 */
function shouldSuppressSound(
  event: SoundEvent,
  activeChannelId: string | null,
  userId: string | null,
  queryClient: QueryClient,
  cooldownMap: Map<string, number>,
): boolean {
  const { senderId, channelId, message } = event

  if (message.messageType === 'system') return true
  if (userId !== null && senderId === userId) return true
  if (channelId === activeChannelId) return true

  const settings = queryClient.getQueryData<NotificationSettingsResponse>(
    queryKeys.notificationSettings.byChannel(channelId),
  )
  if (settings?.level === 'none') return true

  const now = Date.now()
  const lastPlayed = cooldownMap.get(channelId)
  if (lastPlayed !== undefined && now - lastPlayed < COOLDOWN_MS) return true
  cooldownMap.set(channelId, now)

  return false
}

/**
 * WHY: DM servers are NOT in the servers list cache (queryKeys.servers.list()).
 * They live in the DMs cache (queryKeys.dms.list()) where each DmListItem has
 * a serverId. Matching against this cache is the only reliable way to detect
 * whether an incoming message belongs to a DM conversation.
 */
function isDmServer(serverId: string, queryClient: QueryClient): boolean {
  const dms = queryClient.getQueryData<DmListItem[]>(queryKeys.dms.list())
  if (dms === undefined) return false
  return dms.some((dm) => dm.serverId === serverId)
}

function playSound(audio: HTMLAudioElement): void {
  audio.currentTime = 0
  audio.play().catch((err: unknown) => {
    logger.warn('notification_sound_play_failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  })
}

// ── Hook ────────────────────────────────────────────────────────────────

/**
 * Plays notification sounds on incoming messages.
 *
 * WHY: Audio feedback lets users notice messages without watching the screen.
 * Uses different sounds for DMs vs server channels so users can distinguish
 * the source by ear.
 *
 * Guards: system message filter, self-message filter, active channel + focus
 * filter, notification settings (level: 'none'), per-channel cooldown (1s).
 *
 * WHY lazy Audio via useRef (not module-level singletons): avoids import-time
 * side effects that would crash in test/SSR environments where Audio is undefined.
 */
export function useNotificationSound(activeChannelId: string | null, userId: string | null): void {
  const queryClient = useQueryClient()
  const cooldownMap = useRef(new Map<string, number>())
  const dmAudioRef = useRef<HTMLAudioElement | null>(null)
  const channelAudioRef = useRef<HTMLAudioElement | null>(null)

  const handleMessageCreated = useCallback(
    (payload: unknown) => {
      const parsed = soundEventSchema.safeParse(payload)
      if (!parsed.success) {
        logger.warn('notification_sound_parse_failed', {
          error: parsed.error.message,
        })
        return
      }

      const event = parsed.data
      if (shouldSuppressSound(event, activeChannelId, userId, queryClient, cooldownMap.current)) {
        return
      }

      const isDm = isDmServer(event.serverId, queryClient)

      if (isDm) {
        if (dmAudioRef.current === null) {
          dmAudioRef.current = new Audio('/sounds/notification-dm.ogg')
        }
        playSound(dmAudioRef.current)
      } else {
        if (channelAudioRef.current === null) {
          channelAudioRef.current = new Audio('/sounds/notification-channel.ogg')
        }
        playSound(channelAudioRef.current)
      }
    },
    [activeChannelId, userId, queryClient],
  )

  useServerEvent('message.created', handleMessageCreated)
}
