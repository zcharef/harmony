/**
 * Voice connection store — manages LiveKit room lifecycle and local audio state.
 *
 * WHY Zustand: Connection status, mute/deafen, and active speakers are global
 * ephemeral state that the voice panel, channel sidebar, and user avatars all
 * read. Follows the same pattern as crypto-store.ts and presence-store.ts.
 */

import type { Participant, RoomOptions } from 'livekit-client'
import { Room, RoomEvent } from 'livekit-client'
import { create } from 'zustand'

import { logger } from '@/lib/logger'

type VoiceConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'failed'

interface VoiceConnectionState {
  status: VoiceConnectionStatus
  currentChannelId: string | null
  currentServerId: string | null
  room: Room | null
  isMuted: boolean
  isDeafened: boolean
  error: string | null
  /** Set of participant identities currently speaking. */
  activeSpeakers: Set<string>

  connect: (channelId: string, serverId: string, token: string, url: string) => Promise<void>
  disconnect: () => Promise<void>
  toggleMute: () => void
  toggleDeafen: () => void
  /** WHY: PTT needs direct mic control without toggling the isMuted flag.
   * toggleMute is for the UI mute button; setPttMicEnabled is for transient
   * push-to-talk key presses that should not affect the mute toggle state. */
  // TODO(e2ee): PTT key handling may need to be E2EE-aware
  setPttMicEnabled: (enabled: boolean) => void
  reset: () => void
}

const INITIAL_STATE = {
  status: 'idle' as const,
  currentChannelId: null,
  currentServerId: null,
  room: null,
  isMuted: false,
  isDeafened: false,
  error: null,
  activeSpeakers: new Set<string>(),
}

/** WHY: Throttle active-speaker updates to 4 Hz to avoid excessive re-renders. */
const SPEAKER_THROTTLE_MS = 250
let lastSpeakerUpdate = 0

/** WHY: Auto-transition disconnected → idle after a brief delay so the UI
 * shows "Disconnected" feedback before resetting. Stored at module level
 * so connect() and reset() can clear it if the user acts during the delay. */
const DISCONNECT_IDLE_DELAY_MS = 3_000
let disconnectIdleTimer: ReturnType<typeof setTimeout> | null = null

/** WHY: Centralized room options — voice-only, no video tracks. */
const ROOM_OPTIONS: RoomOptions = {
  adaptiveStream: false,
  dynacast: false,
  audioCaptureDefaults: {
    noiseSuppression: true,
    echoCancellation: true,
    autoGainControl: true,
  },
  publishDefaults: {
    dtx: true,
    red: true,
    // WHY: Keep the mic track alive when muted so push-to-talk is instant.
    stopMicTrackOnMute: false,
  },
  disconnectOnPageLeave: true,
}

/** WHY: Remove all RoomEvent listeners we registered, preventing leaks on disconnect. */
function removeRoomListeners(room: Room): void {
  room.removeAllListeners(RoomEvent.Disconnected)
  room.removeAllListeners(RoomEvent.Reconnecting)
  room.removeAllListeners(RoomEvent.Reconnected)
  room.removeAllListeners(RoomEvent.ActiveSpeakersChanged)
  room.removeAllListeners(RoomEvent.MediaDevicesChanged)
  room.removeAllListeners(RoomEvent.AudioPlaybackStatusChanged)
}

export const useVoiceConnectionStore = create<VoiceConnectionState>()((set, get) => ({
  ...INITIAL_STATE,

  connect: async (channelId, serverId, token, url) => {
    // WHY: Cancel any pending disconnected → idle timer if the user reconnects
    // during the brief "Disconnected" feedback window.
    if (disconnectIdleTimer !== null) {
      clearTimeout(disconnectIdleTimer)
      disconnectIdleTimer = null
    }

    const state = get()

    // WHY: If already connected to a room, tear it down first (channel switch).
    if (state.room !== null) {
      await get().disconnect()
    }

    set({ status: 'connecting', error: null })

    const room = new Room(ROOM_OPTIONS)

    // --- Register event handlers before connecting ---

    room.on(RoomEvent.Disconnected, () => {
      const current = get()
      if (current.room === room) {
        removeRoomListeners(room)
        set({
          status: 'disconnected',
          room: null,
          currentChannelId: null,
          currentServerId: null,
          activeSpeakers: new Set(),
        })

        // WHY: Auto-transition to idle after a brief delay so the UI can
        // display "Disconnected" feedback before resetting to clean state.
        if (disconnectIdleTimer !== null) {
          clearTimeout(disconnectIdleTimer)
        }
        disconnectIdleTimer = setTimeout(() => {
          disconnectIdleTimer = null
          if (get().status === 'disconnected') {
            set({ ...INITIAL_STATE, activeSpeakers: new Set() })
          }
        }, DISCONNECT_IDLE_DELAY_MS)
      }
    })

    room.on(RoomEvent.Reconnecting, () => {
      if (get().room === room) {
        set({ status: 'reconnecting' })
      }
    })

    room.on(RoomEvent.Reconnected, () => {
      if (get().room === room) {
        set({ status: 'connected' })
      }
    })

    room.on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
      // WHY: Throttle to 4 Hz — LiveKit fires this at up to 30 Hz.
      const now = Date.now()
      if (now - lastSpeakerUpdate < SPEAKER_THROTTLE_MS) return
      lastSpeakerUpdate = now

      if (get().room === room) {
        const nextIdentities = new Set(speakers.map((s) => s.identity))
        const current = get().activeSpeakers

        // WHY: Skip update if the speaker set is identical — avoids unnecessary
        // React re-renders from a new Set reference on every 4 Hz tick.
        if (
          nextIdentities.size === current.size &&
          [...nextIdentities].every((id) => current.has(id))
        ) {
          return
        }

        set({ activeSpeakers: nextIdentities })
      }
    })

    room.on(RoomEvent.MediaDevicesChanged, () => {
      logger.info('voice_media_devices_changed')
    })

    room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
      // WHY: Logged only — a separate UI component will handle the autoplay prompt.
      logger.info('voice_audio_playback_status_changed', {
        canPlayback: room.canPlaybackAudio,
      })
    })

    try {
      // TODO(e2ee): Pass E2EE options when room-level voice encryption is implemented.
      await room.connect(url, token)
    } catch (err: unknown) {
      removeRoomListeners(room)
      const message = err instanceof Error ? err.message : String(err)
      logger.error('voice_connect_failed', { error: message, channelId, serverId })
      set({ status: 'failed', error: message, room: null })
      return
    }

    // WHY: Mic enablement is separate from room connection. Users without a
    // microphone (or who deny permission) should still join to listen.
    let micFailed = false
    try {
      await room.localParticipant.setMicrophoneEnabled(true)
    } catch (err: unknown) {
      micFailed = true
      logger.warn('voice_mic_enable_failed', {
        error: err instanceof Error ? err.message : String(err),
        channelId,
      })
    }

    set({
      status: 'connected',
      room,
      currentChannelId: channelId,
      currentServerId: serverId,
      isMuted: micFailed,
      isDeafened: false,
    })
  },

  disconnect: async () => {
    const { room } = get()
    if (room !== null) {
      removeRoomListeners(room)
      try {
        await room.disconnect()
      } catch (err: unknown) {
        // WHY: SDK may throw on network error during disconnect. The user
        // expects disconnect to always succeed — we still clean up state.
        logger.warn('voice_disconnect_failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    set({
      status: 'idle',
      room: null,
      currentChannelId: null,
      currentServerId: null,
      error: null,
      isMuted: false,
      isDeafened: false,
      activeSpeakers: new Set(),
    })
  },

  toggleMute: () => {
    const { room, isMuted } = get()
    if (room === null) return
    const nextMuted = !isMuted
    // WHY: setMicrophoneEnabled(true) unmutes, setMicrophoneEnabled(false) mutes.
    room.localParticipant.setMicrophoneEnabled(!nextMuted).catch((err: unknown) => {
      logger.error('voice_toggle_mute_failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    })
    set({ isMuted: nextMuted })
  },

  toggleDeafen: () => {
    const { room, isDeafened } = get()
    if (room === null) return
    const nextDeafened = !isDeafened

    // WHY: Set volume to 0 for all remote participants when deafening,
    // restore to 1 when undeafening. setVolume is the official livekit-client API
    // for per-participant volume control (RemoteParticipant:L42-43).
    for (const participant of room.remoteParticipants.values()) {
      participant.setVolume(nextDeafened ? 0 : 1)
    }

    set({ isDeafened: nextDeafened })
  },

  setPttMicEnabled: (enabled) => {
    const { room } = get()
    if (room === null) return
    room.localParticipant.setMicrophoneEnabled(enabled).catch((err: unknown) => {
      logger.warn('voice_ptt_mic_toggle_failed', {
        error: err instanceof Error ? err.message : String(err),
        enabled,
      })
    })
  },

  reset: () => {
    if (disconnectIdleTimer !== null) {
      clearTimeout(disconnectIdleTimer)
      disconnectIdleTimer = null
    }
    const { room } = get()
    if (room !== null) {
      removeRoomListeners(room)
      room.disconnect().catch((err: unknown) => {
        logger.warn('voice_reset_disconnect_failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }
    set({ ...INITIAL_STATE, activeSpeakers: new Set() })
  },
}))
