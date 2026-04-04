/**
 * Voice connection store — manages LiveKit room lifecycle and local audio state.
 *
 * WHY Zustand: Connection status, mute/deafen, and active speakers are global
 * ephemeral state that the voice panel, channel sidebar, and user avatars all
 * read. Follows the same pattern as crypto-store.ts and presence-store.ts.
 */

import type { KrispNoiseFilterProcessor } from '@livekit/krisp-noise-filter'
import type { Participant, RoomOptions } from 'livekit-client'
import { LocalAudioTrack, Room, RoomEvent, Track } from 'livekit-client'
import { create } from 'zustand'

import { logger } from '@/lib/logger'

export type VoiceConnectionStatus =
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

  /** WHY: KRISP ML-based noise cancellation, enabled by default. Persists across
   * channel switches within a session. */
  isKrispEnabled: boolean

  connect: (channelId: string, serverId: string, token: string, url: string) => Promise<void>
  disconnect: () => Promise<void>
  toggleMute: () => void
  toggleDeafen: () => void
  toggleKrisp: () => void
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
  isKrispEnabled: true,
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

/** WHY: Holds the active KRISP processor so toggleKrisp() can call
 * setEnabled() without tearing down the WASM pipeline. Set on
 * LocalTrackPublished, cleared on disconnect/reset. */
let krispProcessorRef: KrispNoiseFilterProcessor | null = null

/** WHY: Guards against race between toggleKrisp() and the async
 * attachKrispProcessor() init. If the user toggles KRISP off while
 * the processor is still loading, we check isKrispEnabled after
 * completion and call setEnabled(false) to honour the user's intent. */
let krispInitPromise: Promise<void> | null = null

/** WHY: Centralized room options — voice-only, no video tracks. */
const ROOM_OPTIONS: RoomOptions = {
  adaptiveStream: false,
  dynacast: false,
  audioCaptureDefaults: {
    // WHY: Disabled — KRISP ML noise cancellation replaces browser noise suppression.
    // Per LiveKit docs: "models are trained on raw audio and might produce unexpected
    // results if the input has already been processed by a noise cancellation model."
    noiseSuppression: false,
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
  room.removeAllListeners(RoomEvent.TrackSubscribed)
  room.removeAllListeners(RoomEvent.TrackUnsubscribed)
  room.removeAllListeners(RoomEvent.LocalTrackPublished)
  room.removeAllListeners(RoomEvent.LocalTrackUnpublished)
}

function detachAllAudioTracks(room: Room): void {
  for (const p of room.remoteParticipants.values()) {
    for (const pub of p.trackPublications.values()) {
      if (pub.track !== undefined && pub.track.kind === Track.Kind.Audio) {
        for (const el of pub.track.detach()) {
          el.remove()
        }
      }
    }
  }
}

type SetState = (partial: Partial<VoiceConnectionState>) => void
type GetState = () => VoiceConnectionState

/** WHY: Per LiveKit docs, KRISP attaches via LocalTrackPublished event on the
 * mic track. Dynamic import keeps the WASM bundle out of the critical path.
 * Sets krispInitPromise so toggleKrisp() can await ongoing init (P0-6). */
async function attachKrispProcessor(track: LocalAudioTrack): Promise<void> {
  const doAttach = async (): Promise<void> => {
    const { KrispNoiseFilter, isKrispNoiseFilterSupported } = await import(
      '@livekit/krisp-noise-filter'
    )
    if (!isKrispNoiseFilterSupported()) {
      logger.warn('voice_krisp_not_supported')
      return
    }
    const processor = KrispNoiseFilter()
    await track.setProcessor(processor)
    krispProcessorRef = processor
    logger.info('voice_krisp_enabled')

    // WHY: If the user toggled KRISP off while we were loading the WASM,
    // honour their intent by disabling immediately after init completes.
    const { isKrispEnabled } = useVoiceConnectionStore.getState()
    if (!isKrispEnabled) {
      await processor.setEnabled(false)
      logger.info('voice_krisp_disabled_after_init')
    }
  }

  krispInitPromise = doAttach().finally(() => {
    krispInitPromise = null
  })

  return krispInitPromise
}

/** WHY: Extracted to reduce connect() cognitive complexity below Biome's limit of 15. */
function registerRoomEvents(room: Room, get: GetState, set: SetState): void {
  room.on(RoomEvent.Disconnected, () => {
    if (get().room !== room) return
    removeRoomListeners(room)
    set({
      status: 'disconnected',
      room: null,
      currentChannelId: null,
      currentServerId: null,
      activeSpeakers: new Set(),
    })

    if (disconnectIdleTimer !== null) clearTimeout(disconnectIdleTimer)
    disconnectIdleTimer = setTimeout(() => {
      disconnectIdleTimer = null
      if (get().status === 'disconnected') {
        const { isKrispEnabled } = get()
        set({ ...INITIAL_STATE, activeSpeakers: new Set(), isKrispEnabled })
      }
    }, DISCONNECT_IDLE_DELAY_MS)
  })

  room.on(RoomEvent.Reconnecting, () => {
    if (get().room === room) set({ status: 'reconnecting' })
  })

  room.on(RoomEvent.Reconnected, () => {
    if (get().room === room) set({ status: 'connected' })
  })

  room.on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
    const now = Date.now()
    if (now - lastSpeakerUpdate < SPEAKER_THROTTLE_MS) return
    lastSpeakerUpdate = now

    if (get().room !== room) return
    const nextIdentities = new Set(speakers.map((s) => s.identity))
    const current = get().activeSpeakers

    if (
      nextIdentities.size === current.size &&
      [...nextIdentities].every((id) => current.has(id))
    ) {
      return
    }

    set({ activeSpeakers: nextIdentities })
  })

  room.on(RoomEvent.MediaDevicesChanged, () => {
    logger.info('voice_media_devices_changed')
  })

  room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
    logger.info('voice_audio_playback_status_changed', {
      canPlayback: room.canPlaybackAudio,
    })
  })

  room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
    if (track.kind === Track.Kind.Audio) {
      const el = track.attach()
      el.id = `voice-audio-${participant.identity}`

      // WHY (P2-1): On rapid reconnect, a previous audio element with the same
      // id may still exist in the DOM. Remove it to prevent accumulation.
      const existing = document.getElementById(el.id)
      if (existing !== null) existing.remove()

      document.body.appendChild(el)

      // WHY (P1-3): If the user is deafened, new participants who join after
      // toggleDeafen must also be muted. Without this, late-joiners are audible.
      if (get().isDeafened) {
        participant.setVolume(0)
      }
    }
  })

  room.on(RoomEvent.TrackUnsubscribed, (track) => {
    if (track.kind === Track.Kind.Audio) {
      for (const el of track.detach()) {
        el.remove()
      }
    }
  })

  // WHY: Per LiveKit SDK README — clean up local track resources on unpublish.
  room.on(RoomEvent.LocalTrackUnpublished, (trackPublication) => {
    trackPublication.track?.detach()
  })

  // WHY: Per LiveKit docs, KRISP processor must be attached via
  // LocalTrackPublished — this guarantees the track is fully ready.
  // Dynamic import keeps the ~2MB WASM out of the initial bundle.
  room.on(RoomEvent.LocalTrackPublished, (trackPublication) => {
    if (
      trackPublication.source === Track.Source.Microphone &&
      trackPublication.track instanceof LocalAudioTrack &&
      get().isKrispEnabled
    ) {
      attachKrispProcessor(trackPublication.track).catch((err: unknown) => {
        logger.warn('voice_krisp_init_failed', {
          error: err instanceof Error ? err.message : String(err),
        })
        // WHY: If KRISP init fails, the UI must reflect that noise suppression
        // is not active. Without this, the button stays green (misleading).
        set({ isKrispEnabled: false })
      })
    }
  })
}

/** WHY: Extracted to reduce toggleDeafen() cognitive complexity below Biome's
 * limit of 15. Sets volume for all remote participants. Per-participant
 * try/catch (P0-5) so one failure does not stop the rest.
 * Returns the count of participants that failed. */
function setAllParticipantVolumes(room: Room, volume: number): number {
  let failCount = 0
  for (const participant of room.remoteParticipants.values()) {
    try {
      participant.setVolume(volume)
    } catch (err: unknown) {
      failCount += 1
      logger.error('voice_deafen_participant_failed', {
        error: err instanceof Error ? err.message : String(err),
        participantIdentity: participant.identity,
      })
    }
  }
  return failCount
}

/** WHY: Extracted to reduce connect() cognitive complexity below Biome's limit of 15.
 * Enables mic. KRISP attaches automatically via LocalTrackPublished event.
 * Returns true if mic enablement failed. */
async function enableMic(room: Room, channelId: string): Promise<boolean> {
  try {
    await room.localParticipant.setMicrophoneEnabled(true)
    return false
  } catch (err: unknown) {
    logger.warn('voice_mic_enable_failed', {
      error: err instanceof Error ? err.message : String(err),
      channelId,
    })
    return true
  }
}

export const useVoiceConnectionStore = create<VoiceConnectionState>()((set, get) => ({
  ...INITIAL_STATE,

  connect: async (channelId, serverId, token, url) => {
    if (disconnectIdleTimer !== null) {
      clearTimeout(disconnectIdleTimer)
      disconnectIdleTimer = null
    }

    if (get().room !== null) {
      await get().disconnect()
    }

    set({ status: 'connecting', error: null })

    const room = new Room(ROOM_OPTIONS)
    registerRoomEvents(room, get, set)

    try {
      await room.connect(url, token)
    } catch (err: unknown) {
      removeRoomListeners(room)
      const message = err instanceof Error ? err.message : String(err)
      logger.error('voice_connect_failed', { error: message, channelId, serverId })
      set({ status: 'failed', error: message, room: null })
      return
    }

    // WHY: Ensure the AudioContext is running so remote audio can play.
    // TrackSubscribed handles attaching audio elements — no manual iteration needed.
    room.startAudio().catch((err: unknown) => {
      logger.warn('voice_start_audio_failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    })

    const micFailed = await enableMic(room, channelId)

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
    krispProcessorRef = null
    if (room !== null) {
      detachAllAudioTracks(room)
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
    set({ isMuted: nextMuted })
    // WHY: setMicrophoneEnabled(true) unmutes, setMicrophoneEnabled(false) mutes.
    // Optimistic update above; rolled back on failure (P0-4).
    room.localParticipant.setMicrophoneEnabled(!nextMuted).catch((err: unknown) => {
      logger.error('voice_toggle_mute_failed', {
        error: err instanceof Error ? err.message : String(err),
      })
      // WHY (P0-4): Roll back the optimistic isMuted update so the UI
      // reflects the actual mic state after the SDK call failed.
      set({ isMuted: !nextMuted })
    })
  },

  toggleDeafen: () => {
    const { room, isDeafened } = get()
    if (room === null) return
    const nextDeafened = !isDeafened

    // WHY: Set volume to 0 for all remote participants when deafening,
    // restore to 1 when undeafening. setVolume is the official livekit-client API
    // for per-participant volume control (RemoteParticipant:L42-43).
    const failCount = setAllParticipantVolumes(room, nextDeafened ? 0 : 1)

    // WHY (P0-5): If any participant volume change failed, roll back to
    // avoid a half-deafened state where the UI says deafened but some
    // participants are still audible (or vice versa).
    if (failCount > 0) {
      setAllParticipantVolumes(room, isDeafened ? 0 : 1)
      return
    }

    set({ isDeafened: nextDeafened })
  },

  toggleKrisp: () => {
    const { room, isKrispEnabled } = get()
    if (room === null) return
    const nextEnabled = !isKrispEnabled

    // WHY (P0-6): Set state first for instant UI feedback. The async work
    // below will honour this value via the post-init check in attachKrispProcessor.
    set({ isKrispEnabled: nextEnabled })

    // WHY (P0-6): If KRISP WASM is still loading, await it before toggling.
    // attachKrispProcessor already checks isKrispEnabled after init to
    // reconcile, so we just need to wait for it to finish.
    const doToggle = async (): Promise<void> => {
      if (krispInitPromise !== null) {
        await krispInitPromise
      }

      if (krispProcessorRef !== null) {
        // WHY: setEnabled() toggles KRISP without tearing down the WASM pipeline,
        // per LiveKit docs. Much faster than stopProcessor/setProcessor cycle.
        await krispProcessorRef.setEnabled(nextEnabled)
      } else if (nextEnabled) {
        // WHY: Processor was never initialized (e.g., user toggled off before
        // joining, then toggled back on mid-call). Attach fresh.
        const micPub = room.localParticipant.getTrackPublication(Track.Source.Microphone)
        if (micPub?.track instanceof LocalAudioTrack) {
          await attachKrispProcessor(micPub.track)
        }
      }
    }

    doToggle().catch((err: unknown) => {
      logger.warn('voice_krisp_toggle_failed', {
        error: err instanceof Error ? err.message : String(err),
        enabled: nextEnabled,
      })
      // WHY: Roll back optimistic update so the UI reflects actual state.
      set({ isKrispEnabled: !nextEnabled })
    })
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
    krispProcessorRef = null
    const { room } = get()
    if (room !== null) {
      detachAllAudioTracks(room)
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
