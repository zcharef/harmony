/**
 * Voice connection store — manages LiveKit room lifecycle and local audio state.
 *
 * WHY Zustand: Connection status, mute/deafen, and active speakers are global
 * ephemeral state that the voice panel, channel sidebar, and user avatars all
 * read. Follows the same pattern as crypto-store.ts and presence-store.ts.
 */

import type { KrispNoiseFilterProcessor } from '@livekit/krisp-noise-filter'
import type { RoomOptions } from 'livekit-client'
import { DisconnectReason, LocalAudioTrack, Room, RoomEvent, Track } from 'livekit-client'
import { create } from 'zustand'

import { logger } from '@/lib/logger'
import {
  type AudioDeviceKind,
  clearPreferredDeviceId,
  loadPreferredDeafened,
  loadPreferredDeviceId,
  loadPreferredMuted,
  savePreferredDeafened,
  savePreferredDeviceId,
  savePreferredMuted,
} from '../lib/device-preferences'
import { createSpeakingDetector } from '../lib/speaking-detector'

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
  /** WHY: Distinguishes an initial-connect *timeout* (the room never reached
   * 'connected' within CONNECT_TIMEOUT_MS) from other failures so the connection
   * bar can show timeout-specific, actionable copy. The store runs outside React
   * and cannot call i18n, so it emits a typed reason the bar maps to a key —
   * mirrors deviceFallbacks → fallbackNoticeKey. null unless status is 'failed'
   * because of a timeout. */
  connectFailureReason: 'timeout' | null
  /** Set of participant identities currently speaking. */
  activeSpeakers: Set<string>

  /** WHY: KRISP ML-based noise cancellation, enabled by default. Persists across
   * channel switches within a session. */
  isKrispEnabled: boolean

  isPttMode: boolean
  /** WHY: Tauri global shortcut string for PTT. Default is Space —
   * standard in gaming/voice apps. Only used when isPttMode is true. */
  pttShortcut: string
  /** WHY: The shortcut that failed to register globally (e.g. taken by
   * another app), or null when registration is healthy. Enabling PTT is a
   * user-initiated action — a dead hotkey must surface inline in the voice
   * bar, never be a silent no-op (ADR-028). */
  pttRegisterError: string | null

  /** WHY: Survives room recreation (token refresh). Without these, a new Room()
   * defaults to system audio devices, losing the user's selection mid-call.
   * Hydrated from localStorage so the next session reuses the same devices. */
  preferredAudioInputId: string | null
  preferredAudioOutputId: string | null

  /** WHY: Kinds whose preferred device disappeared mid-call (unplugged) and
   * fell back to the system default. A list, not a single value: unplugging a
   * USB headset kills input AND output at once and both notices must survive.
   * The connection bar shows an inline notice — a dead mic must never be silent. */
  deviceFallbacks: AudioDeviceKind[]

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
  togglePttMode: () => void
  setPttShortcut: (shortcut: string) => void
  setPttRegisterError: (shortcut: string | null) => void
  setPreferredDevice: (kind: AudioDeviceKind, deviceId: string) => void
  clearDeviceFallback: () => void
  reset: () => void
}

/** WHY named constant: gives the empty array an explicit element type without
 * an `as` assertion (ADR-035). Never mutated — updates always replace it. */
const NO_DEVICE_FALLBACKS: AudioDeviceKind[] = []

const INITIAL_STATE = {
  status: 'idle' as const,
  currentChannelId: null,
  currentServerId: null,
  room: null,
  // WHY: Hydrated once at module init so pre-call mute/deafen is a persistent
  // user intent (Discord semantics) restored on the next session and applied to
  // the room on connect — mirrors preferredAudioInputId/OutputId below.
  isMuted: loadPreferredMuted(),
  isDeafened: loadPreferredDeafened(),
  isKrispEnabled: true,
  isPttMode: false,
  pttShortcut: 'Space',
  pttRegisterError: null,
  // WHY: Hydrated once at module init so a fresh session restores the devices
  // the user picked last time (restorePreferredDevices applies them on connect).
  preferredAudioInputId: loadPreferredDeviceId('audioinput'),
  preferredAudioOutputId: loadPreferredDeviceId('audiooutput'),
  deviceFallbacks: NO_DEVICE_FALLBACKS,
  error: null,
  connectFailureReason: null,
  activeSpeakers: new Set<string>(),
}

/** WHY: Auto-transition disconnected → idle after a brief delay so the UI
 * shows "Disconnected" feedback before resetting. Stored at module level
 * so connect() and reset() can clear it if the user acts during the delay. */
const DISCONNECT_IDLE_DELAY_MS = 3_000
let disconnectIdleTimer: ReturnType<typeof setTimeout> | null = null

/** WHY: Upper bound for the INITIAL connect — the whole phase (signal + ICE +
 * mic acquisition), not just room.connect(). LiveKit's own guards
 * (peerConnectionTimeout / websocketTimeout) default to 15s each; we sit just
 * above them so a genuine ICE/WS failure surfaces LiveKit's specific error
 * first, while this catches the pathological stall neither internal timer
 * covers — observed in QA as 'Connecting…' forever (unreachable LiveKit, or a
 * mic-permission prompt the user never answers). 20s is far above a normal
 * 1-3s connect, so it never false-positives on a slow-but-working network. Does
 * NOT apply to LiveKit's auto-reconnect of an already-connected session — that
 * path fires Reconnecting/Reconnected and never calls connect(). */
export const CONNECT_TIMEOUT_MS = 20_000

/** WHY: Sentinel so connect()'s catch can tell a connect *timeout* apart from a
 * LiveKit connection error and route to the timeout-specific failure state. */
class VoiceConnectTimeoutError extends Error {
  constructor() {
    super('voice_connect_timeout')
    this.name = 'VoiceConnectTimeoutError'
  }
}

/** WHY: Monotonic id for the current connect() attempt. A newer connect
 * (channel switch), a disconnect (user leaves/cancels), or a reset bumps it, so
 * a superseded attempt's late outcome — including a fired connect timeout — is
 * ignored instead of clobbering newer state or resurrecting a 'failed' bar after
 * the user already moved on. */
let connectGeneration = 0

/** WHY: Holds the active KRISP processor so toggleKrisp() can call
 * setEnabled() without tearing down the WASM pipeline. Set on
 * LocalTrackPublished, cleared on disconnect/reset. */
let krispProcessorRef: KrispNoiseFilterProcessor | null = null

/** WHY: Guards against race between toggleKrisp() and the async
 * attachKrispProcessor() init. If the user toggles KRISP off while
 * the processor is still loading, we check isKrispEnabled after
 * completion and call setEnabled(false) to honour the user's intent. */
let krispInitPromise: Promise<void> | null = null

/** WHY: Stores per-listener cleanup functions so we can remove exactly
 * the callbacks we registered, without nuking third-party listeners
 * via removeAllListeners. Populated by onRoom() in registerRoomEvents,
 * drained by removeRoomListeners(). */
let roomEventCleanups: Array<() => void> = []

/** WHY: Tracks whether the local participant has spoken since the last
 * heartbeat. Consumed (read-and-reset) by the heartbeat interval so the
 * server knows if the user was actively speaking in that window. */
let hasSpokenSinceLastHeartbeat = false

/** WHY: Read-and-reset accessor for the heartbeat. Returns true if the
 * local user spoke since the last call, then clears the flag. */
export function consumeHasSpokenSinceLastHeartbeat(): boolean {
  const val = hasSpokenSinceLastHeartbeat
  hasSpokenSinceLastHeartbeat = false
  return val
}

/** WHY: Stores per-participant detector cleanup functions. Keyed by
 * participant identity so TrackUnsubscribed / LocalTrackUnpublished can
 * clean up the exact detector without affecting others. Same lifecycle
 * pattern as roomEventCleanups. */
let speakerDetectorCleanups = new Map<string, () => void>()

/** WHY: Single AudioContext shared across all participant detectors to avoid
 * creating N contexts. Created lazily on first detector setup, closed on
 * disconnect/reset. Same module-level pattern as krispProcessorRef. */
let sharedAudioContext: AudioContext | null = null

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

/** WHY: Remove exactly the listeners we registered via onRoom(), preventing
 * leaks on disconnect without nuking third-party listeners. */
function removeRoomListeners(): void {
  for (const cleanup of roomEventCleanups) {
    try {
      cleanup()
    } catch (err) {
      logger.warn('voice_listener_cleanup_failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  roomEventCleanups = []
}

/** WHY: Initializes the shared AudioContext lazily. Returns null if creation
 * fails (e.g., browser policy — should not happen after user gesture). */
function getOrCreateAudioContext(): AudioContext | null {
  if (sharedAudioContext !== null) return sharedAudioContext
  try {
    sharedAudioContext = new AudioContext()
    return sharedAudioContext
  } catch (err: unknown) {
    logger.warn('voice_audio_context_failed', {
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/** WHY: Tears down all speaking detectors and the shared AudioContext.
 * Called on disconnect and reset to prevent leaks. */
function cleanupAllSpeakerDetectors(): void {
  for (const cleanup of speakerDetectorCleanups.values()) {
    cleanup()
  }
  speakerDetectorCleanups = new Map()
  if (sharedAudioContext !== null) {
    sharedAudioContext.close().catch(() => {})
    sharedAudioContext = null
  }
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

/** WHY: Extracted to keep registerRoomEvents under Biome complexity limit.
 * Incremental update: adds or removes a single identity from activeSpeakers
 * instead of replacing the entire Set. Skips Zustand update if already in
 * the desired state to avoid unnecessary re-renders. */
function updateSpeaker(identity: string, speaking: boolean, get: GetState, set: SetState): void {
  const current = get().activeSpeakers
  if (speaking) {
    if (current.has(identity)) return
    const next = new Set(current)
    next.add(identity)
    set({ activeSpeakers: next })
  } else {
    if (!current.has(identity)) return
    const next = new Set(current)
    next.delete(identity)
    set({ activeSpeakers: next })
  }
}

/** WHY: Shared by the mid-call unplug path and connect-time restore. Drops the
 * stored preference (the hardware is gone) and records the kind so the
 * connection bar shows an inline notice — the user must never end up with a
 * silently dead mic or speaker. Returns false when the current preference no
 * longer matches: rapid MediaDevicesChanged bursts (docking/undocking) spawn
 * concurrent invocations; only the one still matching proceeds, preventing
 * duplicate fallback switches. */
function applyDeviceGoneFallback(
  kind: AudioDeviceKind,
  preferredId: string,
  get: GetState,
  set: SetState,
): boolean {
  const current = get()
  const currentId =
    kind === 'audioinput' ? current.preferredAudioInputId : current.preferredAudioOutputId
  if (currentId !== preferredId) return false

  logger.warn('voice_preferred_device_unplugged', { kind, deviceId: preferredId })
  clearPreferredDeviceId(kind)
  const fallbacks = current.deviceFallbacks
  const nextFallbacks = fallbacks.includes(kind) ? fallbacks : [...fallbacks, kind]
  if (kind === 'audioinput') {
    set({ preferredAudioInputId: null, deviceFallbacks: nextFallbacks })
  } else {
    set({ preferredAudioOutputId: null, deviceFallbacks: nextFallbacks })
  }
  return true
}

/** WHY: Extracted so both audio kinds share one code path. When the user's
 * preferred device disappears (unplugged mid-call), switch the live session to
 * the system default, drop the stored preference, and record the fallback so
 * the connection bar shows an inline notice. */
async function fallBackIfDeviceGone(
  room: Room,
  kind: AudioDeviceKind,
  preferredId: string,
  get: GetState,
  set: SetState,
): Promise<void> {
  let devices: MediaDeviceInfo[]
  try {
    devices = await Room.getLocalDevices(kind)
  } catch (err: unknown) {
    logger.warn('voice_device_enumeration_failed', {
      kind,
      error: err instanceof Error ? err.message : String(err),
    })
    return
  }
  if (devices.some((d) => d.deviceId === preferredId)) return

  // WHY: applyDeviceGoneFallback re-reads state after the await above and
  // bails if a concurrent invocation already handled this preference.
  if (!applyDeviceGoneFallback(kind, preferredId, get, set)) return

  // WHY: Chromium exposes a synthetic 'default' device; prefer it, otherwise
  // the first available device (Firefox/Safari have no 'default' entry).
  const fallback = devices.find((d) => d.deviceId === 'default') ?? devices[0]
  if (fallback === undefined) return
  try {
    await room.switchActiveDevice(kind, fallback.deviceId)
  } catch (err: unknown) {
    logger.warn('voice_device_fallback_switch_failed', {
      kind,
      deviceId: fallback.deviceId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/** WHY: Runs on RoomEvent.MediaDevicesChanged (hot plug/unplug). Only preferred
 * devices need checking — with no stored preference the browser already tracks
 * the system default on its own. */
function handleMediaDevicesChanged(room: Room, get: GetState, set: SetState): void {
  const { preferredAudioInputId, preferredAudioOutputId } = get()
  if (preferredAudioInputId !== null) {
    void fallBackIfDeviceGone(room, 'audioinput', preferredAudioInputId, get, set)
  }
  if (preferredAudioOutputId !== null) {
    void fallBackIfDeviceGone(room, 'audiooutput', preferredAudioOutputId, get, set)
  }
}

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

    // WHY: Per LiveKit docs, setProcessor does NOT activate the processor.
    // setEnabled(true) must be called explicitly to start noise cancellation.
    // Without this, the KRISP WASM pipeline is loaded but inactive — the UI
    // shows the green button while no noise cancellation actually runs.
    const { isKrispEnabled } = useVoiceConnectionStore.getState()
    await processor.setEnabled(isKrispEnabled)
    logger.info('voice_krisp_initialized', { enabled: isKrispEnabled })
  }

  krispInitPromise = doAttach().finally(() => {
    krispInitPromise = null
  })

  return krispInitPromise
}

/** WHY (bug 3): The local activity ring must analyze the SAME audio that is
 * published — post-KRISP when KRISP is on (so the ring does not light on
 * keyboard noise KRISP strips from the outgoing track), and the raw capture
 * track when KRISP is off (nothing is filtered, so raw IS the published audio).
 * KRISP attaches asynchronously, so binding the detector synchronously in
 * LocalTrackPublished pins it to the RAW pre-KRISP track forever. This helper
 * (re)binds the detector to the currently-correct track and is called AFTER
 * attach resolves and on every processed-track change (KRISP toggle, input
 * device switch). Reads getProcessor()?.processedTrack — the processed
 * MediaStreamTrack KRISP exposes — falling back to the raw capture track. */
function rebuildLocalSpeakingDetector(
  track: LocalAudioTrack,
  room: Room,
  get: GetState,
  set: SetState,
): void {
  const audioCtx = getOrCreateAudioContext()
  if (audioCtx === null) return

  const localIdentity = room.localParticipant.identity

  // WHY: Tear down the previous local detector before rebinding so we never
  // leak an AnalyserNode still wired to the old (raw or previous-mic) track.
  const existing = speakerDetectorCleanups.get(localIdentity)
  if (existing !== undefined) {
    existing()
    speakerDetectorCleanups.delete(localIdentity)
  }

  // WHY: Only read the processed track when KRISP is enabled. When it is off the
  // published audio is the raw capture track, so the ring must read raw too.
  const processedTrack = get().isKrispEnabled ? track.getProcessor()?.processedTrack : undefined
  const sourceTrack = processedTrack ?? track.mediaStreamTrack

  const detectorCleanup = createSpeakingDetector(audioCtx, sourceTrack, (speaking) => {
    if (speaking) hasSpokenSinceLastHeartbeat = true
    updateSpeaker(localIdentity, speaking, get, set)
  })
  speakerDetectorCleanups.set(localIdentity, detectorCleanup)
}

/** WHY (bug 2 + bug 3): switchActiveDevice('audioinput', …) replaces the mic
 * track and emits TrackEvent.Restarted — NOT LocalTrackPublished — so the
 * KRISP-attach wired to LocalTrackPublished never re-runs. LiveKit's internal
 * processor.restart() rebuilds the worklet but leaves it DISABLED, so KRISP
 * silently stops suppressing noise on the new mic. Re-assert the user's KRISP
 * toggle state on the new track, then rebuild the local speaking detector from
 * the resulting processed track (bug 3) once the re-assert settles — so the
 * detector never binds to the raw new-mic capture. Covers the manual selector
 * switch AND the store's restorePreferredDevice / fallBackIfDeviceGone paths. */
function reapplyKrispOnInputChange(
  track: LocalAudioTrack,
  room: Room,
  get: GetState,
  set: SetState,
): void {
  const { isKrispEnabled } = get()

  const reassert = async (): Promise<void> => {
    // WHY: Await any in-flight initial attach so we do not race its setEnabled.
    if (krispInitPromise !== null) await krispInitPromise
    if (krispProcessorRef !== null) {
      // WHY: Re-apply the user's toggle state — respect KRISP-off, never
      // force-enable. LiveKit left the rebuilt worklet disabled.
      await krispProcessorRef.setEnabled(isKrispEnabled)
    } else if (isKrispEnabled) {
      // WHY: No processor yet (KRISP was off at publish, toggled on, then the
      // device switched) — attach fresh on the current mic track.
      await attachKrispProcessor(track)
    }
  }

  reassert()
    .catch((err: unknown) => {
      logger.warn('voice_krisp_device_change_reapply_failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    })
    .finally(() => {
      // WHY (bug 3): Rebuild AFTER the re-assert settles so processedTrack is the
      // new mic's, not the previous one. On KRISP-off it reads the raw track.
      rebuildLocalSpeakingDetector(track, room, get, set)
    })
}

/** WHY: Runs on RoomEvent.ActiveDeviceChanged. Only an audioinput change touches
 * the mic pipeline (KRISP + the local detector); audiooutput/videoinput changes
 * are irrelevant. */
function handleActiveDeviceChanged(
  kind: MediaDeviceKind,
  room: Room,
  get: GetState,
  set: SetState,
): void {
  if (kind !== 'audioinput') return
  const micPub = room.localParticipant.getTrackPublication(Track.Source.Microphone)
  const track = micPub?.track
  if (!(track instanceof LocalAudioTrack)) return

  reapplyKrispOnInputChange(track, room, get, set)
}

/** WHY: Rebind the local speaking detector to the current mic publication's
 * track. Shared by toggleKrisp (raw ↔ processed swap) so the caller stays under
 * Biome's cognitive-complexity limit; no-op when there is no local mic track. */
function rebuildDetectorFromMic(room: Room, get: GetState, set: SetState): void {
  const micPub = room.localParticipant.getTrackPublication(Track.Source.Microphone)
  if (micPub?.track instanceof LocalAudioTrack) {
    rebuildLocalSpeakingDetector(micPub.track, room, get, set)
  }
}

/** WHY: Extracted to reduce connect() cognitive complexity below Biome's limit of 15. */
function registerRoomEvents(room: Room, get: GetState, set: SetState): void {
  /** WHY: Registers a listener and stores a cleanup closure so removeRoomListeners()
   * can remove exactly our callback without nuking third-party listeners. */
  // biome-ignore lint/suspicious/noExplicitAny: LiveKit EventEmitter requires `any` for callback args
  function onRoom<E extends RoomEvent>(event: E, callback: (...args: any[]) => void) {
    room.on(event, callback)
    roomEventCleanups.push(() => room.off(event, callback))
  }

  // WHY: Per LiveKit docs, the Disconnected callback receives a DisconnectReason
  // that distinguishes intentional disconnects from errors. Logging it aids
  // diagnosis; DUPLICATE_IDENTITY in particular fires during token refresh when
  // the old and new Room share the same participant identity.
  onRoom(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
    if (get().room !== room) return

    logger.info('voice_room_disconnected', {
      reason: reason !== undefined ? DisconnectReason[reason] : 'unknown',
      channelId: get().currentChannelId,
    })

    removeRoomListeners()
    cleanupAllSpeakerDetectors()
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
        const {
          isKrispEnabled,
          isPttMode,
          pttShortcut,
          preferredAudioInputId,
          preferredAudioOutputId,
          isMuted,
          isDeafened,
        } = get()
        set({
          ...INITIAL_STATE,
          activeSpeakers: new Set(),
          isKrispEnabled,
          isPttMode,
          pttShortcut,
          preferredAudioInputId,
          preferredAudioOutputId,
          // WHY: mute/deafen is a persistent user intent (like the device IDs
          // above) — preserve it across the disconnect→idle reset so the next
          // join re-applies it, rather than forcing unmuted/undeafened.
          isMuted,
          isDeafened,
        })
      }
    }, DISCONNECT_IDLE_DELAY_MS)
  })

  onRoom(RoomEvent.Reconnecting, () => {
    if (get().room === room) set({ status: 'reconnecting' })
  })

  onRoom(RoomEvent.Reconnected, () => {
    if (get().room === room) set({ status: 'connected' })
  })

  onRoom(RoomEvent.MediaDevicesChanged, () => {
    logger.info('voice_media_devices_changed')
    if (get().room === room) handleMediaDevicesChanged(room, get, set)
  })

  onRoom(RoomEvent.AudioPlaybackStatusChanged, () => {
    logger.info('voice_audio_playback_status_changed', {
      canPlayback: room.canPlaybackAudio,
    })
  })

  onRoom(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
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

      // WHY: Client-side speaking detection — analyze the decoded remote
      // audio for instant visual sync with what the user hears.
      const audioCtx = getOrCreateAudioContext()
      if (audioCtx !== null) {
        const detectorCleanup = createSpeakingDetector(
          audioCtx,
          track.mediaStreamTrack,
          (speaking) => updateSpeaker(participant.identity, speaking, get, set),
        )
        speakerDetectorCleanups.set(participant.identity, detectorCleanup)
      }
    }
  })

  onRoom(RoomEvent.TrackUnsubscribed, (track, _pub, participant) => {
    if (track.kind === Track.Kind.Audio) {
      const detectorCleanup = speakerDetectorCleanups.get(participant.identity)
      if (detectorCleanup !== undefined) {
        detectorCleanup()
        speakerDetectorCleanups.delete(participant.identity)
      }
      for (const el of track.detach()) {
        el.remove()
      }
    }
  })

  onRoom(RoomEvent.LocalTrackUnpublished, (trackPublication) => {
    if (trackPublication.source === Track.Source.Microphone) {
      const localIdentity = room.localParticipant.identity
      const detectorCleanup = speakerDetectorCleanups.get(localIdentity)
      if (detectorCleanup !== undefined) {
        detectorCleanup()
        speakerDetectorCleanups.delete(localIdentity)
      }
    }
    trackPublication.track?.detach()
  })

  onRoom(RoomEvent.LocalTrackPublished, (trackPublication) => {
    if (
      trackPublication.source === Track.Source.Microphone &&
      trackPublication.track instanceof LocalAudioTrack
    ) {
      const localTrack = trackPublication.track
      // WHY: KRISP attaches via LocalTrackPublished per LiveKit docs.
      if (get().isKrispEnabled) {
        attachKrispProcessor(localTrack)
          .catch((err: unknown) => {
            logger.warn('voice_krisp_init_failed', {
              error: err instanceof Error ? err.message : String(err),
            })
            set({ isKrispEnabled: false })
          })
          // WHY (bug 3): Build the local speaking detector only AFTER attach
          // settles so it binds to the post-KRISP processed track — never the
          // raw pre-KRISP capture. On failure isKrispEnabled is now false, so
          // rebuild reads the raw track (correct — nothing is filtered).
          .finally(() => {
            rebuildLocalSpeakingDetector(localTrack, room, get, set)
          })
      } else {
        // WHY: KRISP off — the published audio is the raw capture track, so the
        // detector reads it directly (nothing is filtered).
        rebuildLocalSpeakingDetector(localTrack, room, get, set)
      }
    }
  })

  // WHY (bug 2 + bug 3): An input-device switch replaces the mic track without
  // re-firing LocalTrackPublished. Re-assert KRISP to the user's toggle state
  // and rebind the detector to the new processed track.
  onRoom(RoomEvent.ActiveDeviceChanged, (kind: MediaDeviceKind) => {
    if (get().room !== room) return
    handleActiveDeviceChanged(kind, room, get, set)
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
      logger.warn('voice_deafen_participant_failed', {
        error: err instanceof Error ? err.message : String(err),
        participantIdentity: participant.identity,
      })
    }
  }
  return failCount
}

/** WHY: Applies the persisted pre-call mute/deafen intent to a freshly-joined
 * room. enableMic() always publishes the mic track (so KRISP attaches and the
 * micFailed signal is real); this runs AFTER the connected `set` to honour a
 * muted/deafened intent by disabling the mic, and — when deafened — silencing
 * already-subscribed participants. Late joiners are covered by the
 * TrackSubscribed isDeafened guard as long as isDeafened is in state first. */
function applyInitialAudioState(room: Room, muted: boolean, deafened: boolean): void {
  if (!muted && !deafened) return
  room.localParticipant.setMicrophoneEnabled(false).catch((err: unknown) => {
    logger.warn('voice_initial_mute_failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  })
  if (deafened) {
    setAllParticipantVolumes(room, 0)
  }
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

/** WHY: A device unplugged BETWEEN sessions never fires MediaDevicesChanged,
 * so connect-time restore must verify the persisted ID still exists before
 * switching. If gone: same clear + inline-notice treatment as a mid-call
 * unplug — no device switch needed, the system default is already active
 * from enableMic. */
async function restorePreferredDevice(
  room: Room,
  kind: AudioDeviceKind,
  preferredId: string,
  get: GetState,
  set: SetState,
): Promise<void> {
  try {
    const devices = await Room.getLocalDevices(kind)
    if (!devices.some((d) => d.deviceId === preferredId)) {
      applyDeviceGoneFallback(kind, preferredId, get, set)
      return
    }
  } catch (err: unknown) {
    // WHY: Enumeration failure is not proof the device is gone — keep the
    // preference and attempt the switch; a truly stale ID surfaces below
    // as a switch failure.
    logger.warn('voice_device_enumeration_failed', {
      kind,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  try {
    await room.switchActiveDevice(kind, preferredId)
  } catch (err: unknown) {
    logger.warn('voice_restore_preferred_device_failed', {
      kind,
      deviceId: preferredId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/** WHY: Extracted to reduce connect() cognitive complexity. Restores the user's
 * preferred audio devices after room creation (token refresh recreates a Room
 * mid-call; a fresh session hydrates persisted preferences). Fire-and-forget
 * per kind — restore failures must not block the connect flow. */
function restorePreferredDevices(room: Room, get: GetState, set: SetState): void {
  const { preferredAudioInputId, preferredAudioOutputId } = get()
  if (preferredAudioInputId !== null) {
    void restorePreferredDevice(room, 'audioinput', preferredAudioInputId, get, set)
  }
  if (preferredAudioOutputId !== null) {
    void restorePreferredDevice(room, 'audiooutput', preferredAudioOutputId, get, set)
  }
}

/** WHY: Extracted to reduce connect() cognitive complexity below Biome's limit of 15.
 * Tears down an existing room without setting status to 'idle' (which disconnect()
 * does), avoiding a transient idle→connecting flicker on channel switch. */
async function teardownOldRoom(oldRoom: Room): Promise<void> {
  detachAllAudioTracks(oldRoom)
  removeRoomListeners()
  cleanupAllSpeakerDetectors()
  try {
    await oldRoom.disconnect()
  } catch (err: unknown) {
    logger.warn('voice_connect_old_room_disconnect_failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/** WHY: room.connect() + remote-audio start + mic acquisition, exposed as one
 * awaitable so connect() can race the WHOLE connecting phase against
 * CONNECT_TIMEOUT_MS — the stall can be at room.connect() OR at mic-permission
 * acquisition. Returns micFailed so connect() sets the initial mute state.
 * startAudio is fire-and-forget: remote playback must not block reaching
 * 'connected' (TrackSubscribed attaches the audio elements). */
async function establishConnection(
  room: Room,
  channelId: string,
  url: string,
  token: string,
): Promise<boolean> {
  await room.connect(url, token)
  room.startAudio().catch((err: unknown) => {
    logger.warn('voice_start_audio_failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  })
  return enableMic(room, channelId)
}

/** WHY: Extracted to keep connect() under Biome's cognitive-complexity limit.
 * Handles a failed or timed-out INITIAL connect: guards against a superseded
 * attempt (generation mismatch — a newer connect/disconnect/reset owns the
 * shared listeners now, so only tear down this orphan room and bail), otherwise
 * releases the half-open room (WebSocket/WebRTC + mic track, so retry starts
 * fresh) and moves the state machine to 'failed' with the matching reason. */
function handleConnectFailure(
  err: unknown,
  room: Room,
  generation: number,
  channelId: string,
  serverId: string,
  set: SetState,
): void {
  if (connectGeneration !== generation) {
    room.disconnect().catch(() => {})
    return
  }
  removeRoomListeners()
  room.disconnect().catch(() => {})
  krispProcessorRef = null
  if (err instanceof VoiceConnectTimeoutError) {
    logger.warn('voice_connect_timeout', { channelId, serverId, timeoutMs: CONNECT_TIMEOUT_MS })
    set({ status: 'failed', error: null, room: null, connectFailureReason: 'timeout' })
    return
  }
  const message = err instanceof Error ? err.message : String(err)
  logger.warn('voice_connect_failed', { error: message, channelId, serverId })
  // WHY: Reset connectFailureReason explicitly (not just at connect() start) so
  // the bar never pairs a server error message with stale timeout copy, even if
  // a future path reaches 'failed' without re-entering connect().
  set({ status: 'failed', error: message, room: null, connectFailureReason: null })
}

export const useVoiceConnectionStore = create<VoiceConnectionState>()((set, get) => ({
  ...INITIAL_STATE,

  connect: async (channelId, serverId, token, url) => {
    if (disconnectIdleTimer !== null) {
      clearTimeout(disconnectIdleTimer)
      disconnectIdleTimer = null
    }

    // WHY: A new attempt supersedes any in-flight one so a stale connect's late
    // outcome (including a fired timeout) cannot clobber this attempt's state.
    connectGeneration += 1
    const generation = connectGeneration

    // WHY: Set connecting BEFORE tearing down the old room to avoid a transient
    // idle→connecting flicker that causes VoiceConnectionBar to animate out then back in.
    set({ status: 'connecting', error: null, connectFailureReason: null })

    // WHY: teardownOldRoom instead of disconnect() — disconnect() sets status to
    // 'idle' which would overwrite the 'connecting' we just set above.
    const { room: oldRoom } = get()
    if (oldRoom !== null) {
      await teardownOldRoom(oldRoom)
    }

    const room = new Room(ROOM_OPTIONS)
    registerRoomEvents(room, get, set)

    // WHY: Bound the whole connecting phase. On success the timer is cleared in
    // the finally, so it can never fire after a completed connect; leaving or a
    // channel switch bumps the generation, so a fired timeout is ignored.
    let timeoutId: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new VoiceConnectTimeoutError()), CONNECT_TIMEOUT_MS)
    })
    const establishPromise = establishConnection(room, channelId, url, token)
    // WHY: If the timeout wins the race, establishPromise stays pending and may
    // reject later once we tear the room down — swallow that late rejection so
    // it does not surface as an unhandledRejection.
    establishPromise.catch(() => {})

    try {
      const micFailed = await Promise.race([establishPromise, timeout])
      // WHY: Same generation guard as the failure path — a newer connect, a
      // disconnect (user left), or a reset superseded this attempt while it was
      // establishing. Tear down this now-orphaned room instead of resurrecting
      // 'connected' (and a live room nothing else tracks) over the newer state.
      if (connectGeneration !== generation) {
        room.disconnect().catch(() => {})
        return
      }
      // WHY: Apply the persisted pre-call mute/deafen intent on join. Read it
      // from state (hydrated at init, kept across disconnect) BEFORE the set.
      // micFailed forces mute regardless — a dead mic must show as muted.
      const { isMuted: persistedMuted, isDeafened: persistedDeafened } = get()
      const nextMuted = micFailed || persistedMuted
      set({
        status: 'connected',
        room,
        currentChannelId: channelId,
        currentServerId: serverId,
        isMuted: nextMuted,
        isDeafened: persistedDeafened,
      })
      applyInitialAudioState(room, nextMuted, persistedDeafened)
      restorePreferredDevices(room, get, set)
    } catch (err: unknown) {
      handleConnectFailure(err, room, generation, channelId, serverId, set)
    } finally {
      if (timeoutId !== null) clearTimeout(timeoutId)
    }
  },

  disconnect: async () => {
    // WHY: Invalidate any in-flight connect so its timeout/late outcome cannot
    // resurrect a 'failed' bar after the user has left.
    connectGeneration += 1
    const { room } = get()
    krispProcessorRef = null
    cleanupAllSpeakerDetectors()
    if (room !== null) {
      detachAllAudioTracks(room)
      removeRoomListeners()
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
    // WHY: preferredAudioInputId / preferredAudioOutputId are intentionally
    // NOT cleared here. They are user preferences that should persist across
    // disconnect → rejoin so the same devices are restored automatically.
    // WHY isMuted/isDeafened are NOT reset: they are a persistent self-mute
    // intent (Discord semantics) that survives leaving a call and is re-applied
    // on the next join, matching the preferred-device persistence above.
    set({
      status: 'idle',
      room: null,
      currentChannelId: null,
      currentServerId: null,
      error: null,
      connectFailureReason: null,
      deviceFallbacks: [],
      activeSpeakers: new Set(),
    })
  },

  toggleMute: () => {
    const { room, isMuted } = get()
    const nextMuted = !isMuted
    // WHY: Persist first so the mute intent survives a reload and is re-applied
    // on the next join — works pre-call (room === null) exactly like the
    // device-preference persistence.
    set({ isMuted: nextMuted })
    savePreferredMuted(nextMuted)
    // WHY: Pre-call there is no room to act on — the persisted intent is enough;
    // connect() applies it via applyInitialAudioState.
    if (room === null) return
    // WHY: setMicrophoneEnabled(true) unmutes, setMicrophoneEnabled(false) mutes.
    // Optimistic update above; rolled back on failure (P0-4).
    room.localParticipant.setMicrophoneEnabled(!nextMuted).catch((err: unknown) => {
      logger.error('voice_toggle_mute_failed', {
        error: err instanceof Error ? err.message : String(err),
      })
      // WHY (P0-4): Roll back the optimistic isMuted update (and its persisted
      // copy) so the UI reflects the actual mic state after the SDK call failed.
      set({ isMuted: !nextMuted })
      savePreferredMuted(!nextMuted)
    })
  },

  toggleDeafen: () => {
    const { room, isDeafened, isMuted } = get()
    const nextDeafened = !isDeafened

    // WHY: Pre-call — flip and persist the intent (deafen implies mute, Discord
    // semantics), then stop. connect() applies it via applyInitialAudioState.
    if (room === null) {
      set({ isDeafened: nextDeafened, isMuted: nextDeafened })
      savePreferredDeafened(nextDeafened)
      savePreferredMuted(nextDeafened)
      return
    }

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

    // WHY: Deafen implies mute — if you can't hear others, you shouldn't
    // broadcast either (Discord/TeamSpeak standard). Undeafen restores the mic.
    set({ isDeafened: nextDeafened, isMuted: nextDeafened })
    savePreferredDeafened(nextDeafened)
    savePreferredMuted(nextDeafened)
    room.localParticipant.setMicrophoneEnabled(!nextDeafened).catch((err: unknown) => {
      logger.error('voice_deafen_mic_toggle_failed', {
        error: err instanceof Error ? err.message : String(err),
        deafened: nextDeafened,
      })
      // WHY (P0-4): Roll back both flags (and their persisted copies) and
      // restore participant volumes so the UI reflects the actual mic/audio
      // state after the SDK call failed.
      set({ isDeafened, isMuted })
      savePreferredDeafened(isDeafened)
      savePreferredMuted(isMuted)
      setAllParticipantVolumes(room, isDeafened ? 0 : 1)
    })
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

      // WHY (bug 3): The published audio just changed (raw ↔ post-KRISP), so
      // rebuild the detector to read the new source — processed when now on,
      // raw when now off — keeping the activity ring in sync with the toggle.
      rebuildDetectorFromMic(room, get, set)
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
    const { room, isDeafened } = get()
    if (room === null) return
    // WHY: Deafen is a stronger contract than PTT — if the user deafened,
    // a PTT key press must NOT re-enable the mic. Without this guard,
    // holding the PTT key while deafened would broadcast audio while the
    // UI shows the deafen icon.
    if (enabled && isDeafened) return
    room.localParticipant.setMicrophoneEnabled(enabled).catch((err: unknown) => {
      logger.warn('voice_ptt_mic_toggle_failed', {
        error: err instanceof Error ? err.message : String(err),
        enabled,
      })
    })
  },

  togglePttMode: () => {
    const { room, isPttMode } = get()
    const nextPttMode = !isPttMode
    // WHY clear the register error on every toggle: turning PTT off removes
    // the failing registration; turning it on retries and will re-set the
    // error if it still fails.
    set({ isPttMode: nextPttMode, pttRegisterError: null })
    // WHY: When PTT is toggled ON, mute the mic so the user must hold the key
    // to speak. When toggled OFF, unmute to return to normal voice mode.
    if (room !== null) {
      room.localParticipant.setMicrophoneEnabled(!nextPttMode).catch((err: unknown) => {
        set({ isPttMode: !nextPttMode })
        logger.warn('voice_ptt_mode_mic_toggle_failed', {
          error: err instanceof Error ? err.message : String(err),
          pttMode: nextPttMode,
        })
      })
    }
  },

  setPttShortcut: (shortcut) => {
    // WHY clear the error: it references the OLD shortcut — the register
    // effect re-runs for the new one and re-sets the error if still failing.
    set({ pttShortcut: shortcut, pttRegisterError: null })
  },

  setPttRegisterError: (shortcut) => {
    set({ pttRegisterError: shortcut })
  },

  setPreferredDevice: (kind, deviceId) => {
    // WHY: Persist immediately so the choice survives a page reload even if the
    // user never disconnects cleanly.
    savePreferredDeviceId(kind, deviceId)
    if (kind === 'audioinput') set({ preferredAudioInputId: deviceId })
    else set({ preferredAudioOutputId: deviceId })
  },

  clearDeviceFallback: () => {
    set({ deviceFallbacks: [] })
  },

  reset: () => {
    if (disconnectIdleTimer !== null) {
      clearTimeout(disconnectIdleTimer)
      disconnectIdleTimer = null
    }
    // WHY: Invalidate any in-flight connect so its timeout cannot fire after
    // the store has been torn down.
    connectGeneration += 1
    krispProcessorRef = null
    cleanupAllSpeakerDetectors()
    const { room } = get()
    if (room !== null) {
      detachAllAudioTracks(room)
      removeRoomListeners()
      room.disconnect().catch((err: unknown) => {
        logger.warn('voice_reset_disconnect_failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }
    const {
      isKrispEnabled,
      isPttMode,
      pttShortcut,
      preferredAudioInputId,
      preferredAudioOutputId,
      isMuted,
      isDeafened,
    } = get()
    set({
      ...INITIAL_STATE,
      activeSpeakers: new Set(),
      isKrispEnabled,
      isPttMode,
      pttShortcut,
      preferredAudioInputId,
      preferredAudioOutputId,
      // WHY: preserve the persistent self-mute/deafen intent across reset,
      // matching the preferred-device IDs above.
      isMuted,
      isDeafened,
    })
  },
}))
