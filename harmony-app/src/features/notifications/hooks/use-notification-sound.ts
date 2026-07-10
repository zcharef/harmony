import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useRef } from 'react'
import { z } from 'zod'
import { dmServerFlag } from '@/features/channels'
import { usePreferences } from '@/features/preferences'
import { useServerEvent } from '@/hooks/use-server-event'
import { logger } from '@/lib/logger'
import { classifyEvent, shouldSuppress } from '../lib/notification-policy'
import { useNotificationSettingsMap } from './use-notification-settings-map'

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
    // WHY optional: older API instances omit the field during rollout.
    mentions: z.array(z.object({ userId: z.string() })).optional(),
  }),
})

const NOTIFICATION_VOLUME = 0.6

function playSound(audio: HTMLAudioElement): void {
  audio.volume = NOTIFICATION_VOLUME
  audio.currentTime = 0
  audio.play().catch((err: unknown) => {
    logger.warn('notification_sound_play_failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  })
}

/**
 * WHY: Extracted to keep the handler under Biome's cognitive complexity limit.
 * Class-based pick: 'unknown' (cache race) falls back to the channel ogg —
 * accepted mis-classification window of one refetch. Lazy Audio construction
 * (see hook WHY).
 */
function pickAndPlay(
  isDm: boolean,
  dmAudioRef: React.RefObject<HTMLAudioElement | null>,
  channelAudioRef: React.RefObject<HTMLAudioElement | null>,
): void {
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
}

// ── Hook ────────────────────────────────────────────────────────────────

/**
 * Plays notification sounds on incoming messages (different sounds for DMs vs
 * server channels so users can distinguish the source by ear).
 *
 * Suppression is delegated to the pure policy module: DND, the sounds master
 * switch, system/self filters, "seen" (active channel AND focused — an
 * unfocused window still gets sound for the open channel, Discord parity),
 * per-event-type switches, the bulk per-channel level map, 1s cooldown.
 *
 * WHY lazy Audio via useRef (not module-level singletons): avoids import-time
 * side effects that would crash in test/SSR environments where Audio is
 * undefined.
 */
export function useNotificationSound(activeChannelId: string | null, userId: string | null): void {
  const queryClient = useQueryClient()
  const preferences = usePreferences()
  const { data: levelMap } = useNotificationSettingsMap()
  const cooldownMap = useRef(new Map<string, number>())
  const dmAudioRef = useRef<HTMLAudioElement | null>(null)
  const channelAudioRef = useRef<HTMLAudioElement | null>(null)

  const prefs = preferences.data

  const handleMessageCreated = useCallback(
    (payload: unknown) => {
      const parsed = soundEventSchema.safeParse(payload)
      if (!parsed.success) {
        logger.warn('notification_sound_parse_failed', {
          error: parsed.error.message,
        })
        return
      }

      const { senderId, serverId, channelId, message } = parsed.data

      const eventClass = classifyEvent({
        serverIsDm: dmServerFlag(serverId, queryClient),
        mentionedUserIds: message.mentions?.map((m) => m.userId),
        currentUserId: userId ?? '',
      })

      const now = Date.now()
      const lastPlayed = cooldownMap.current.get(channelId)
      const cooldownHit = lastPlayed !== undefined && now - lastPlayed < COOLDOWN_MS

      const suppressed = shouldSuppress({
        kind: 'sound',
        prefs,
        channelLevel: levelMap?.[channelId],
        eventClass,
        isSelf: userId !== null && senderId === userId,
        isSystem: message.messageType === 'system',
        isActiveChannel: channelId === activeChannelId,
        hasFocus: document.hasFocus(),
        // WHY false: gate 6 is desktop-only — sound plays per-tab (D6).
        anyTabFocused: false,
        cooldownHit,
      })
      if (suppressed) return

      cooldownMap.current.set(channelId, now)

      pickAndPlay(eventClass === 'dm', dmAudioRef, channelAudioRef)
    },
    [activeChannelId, userId, queryClient, prefs, levelMap],
  )

  useServerEvent('message.created', handleMessageCreated)
}
