/**
 * Voice channel sound effects — join and leave/disconnect audio cues.
 *
 * WHY module-level lazy refs (not a hook): These sounds are triggered from both
 * use-voice-connection (self join/leave) and use-realtime-voice (others join/leave).
 * A plain module avoids duplicating Audio elements across hook instances.
 *
 * Pattern reference: use-notification-sound.ts (lazy Audio, playSound helper).
 */

import { logger } from '@/lib/logger'

export type VoiceSoundType = 'join' | 'leave'

const VOLUME = 0.5

/** WHY 1s cooldown: Prevents audio spam when multiple participants join/leave
 * in rapid succession (e.g., a group joining together). Same rationale as
 * COOLDOWN_MS in use-notification-sound.ts. */
const COOLDOWN_MS = 1_000

const SOUND_PATHS: Record<VoiceSoundType, string> = {
  join: '/sounds/voice-join.ogg',
  leave: '/sounds/voice-leave.ogg',
}

/** WHY lazy: Avoids creating Audio elements at import time, which would crash
 * in test/SSR environments where Audio is undefined. */
const audioRefs: Record<VoiceSoundType, HTMLAudioElement | null> = {
  join: null,
  leave: null,
}

const lastPlayedAt: Record<VoiceSoundType, number> = {
  join: 0,
  leave: 0,
}

/**
 * Plays a voice channel sound effect with per-type cooldown.
 *
 * WHY cooldown is always applied: Self-actions (join/leave) are state-machine
 * gated (idle->connected->idle) so the cooldown never triggers in practice.
 * For others' SSE events, it prevents audio spam during participant churn.
 */
export function playVoiceSound(type: VoiceSoundType): void {
  const now = Date.now()
  if (now - lastPlayedAt[type] < COOLDOWN_MS) return
  lastPlayedAt[type] = now

  // WHY local variable: TypeScript does not narrow bracket-indexed access
  // (audioRefs[type]) when the index is a parameter. Assigning to a local
  // lets the if-block narrow from `HTMLAudioElement | null` to `HTMLAudioElement`.
  let audio = audioRefs[type]
  if (audio === null) {
    audio = new Audio(SOUND_PATHS[type])
    audioRefs[type] = audio
  }

  audio.volume = VOLUME
  audio.currentTime = 0
  audio.play().catch((err: unknown) => {
    logger.warn('voice_sound_play_failed', {
      type,
      error: err instanceof Error ? err.message : String(err),
    })
  })
}
