# Client-Side Speaking Detection via Web Audio API AnalyserNode

**Date:** 2026-04-13
**Status:** Approved
**Scope:** `harmony-app/src/features/voice/`

## Problem

The voice channel speaking indicator (green ring on avatars) suffers from three issues:

1. **Late activation (~200-400ms):** The indicator lights up well after the user has started speaking.
2. **Late deactivation (~300-500ms):** The indicator stays on after the user has clearly stopped speaking.
3. **Low sensitivity:** Quiet/soft speech never triggers the indicator at all.

**Root cause:** All three symptoms stem from the exclusive reliance on `RoomEvent.ActiveSpeakersChanged`, which is a server-mediated signal. The audio goes to the LiveKit SFU, the SFU detects speech (with its own fixed threshold and timing), and sends a signaling update back to the client. This adds network round-trip latency and provides no control over the detection threshold.

Confirmed in LiveKit SDK source (`livekit-client.esm.mjs:28684-28714`): `Participant.audioLevel` and `Participant.isSpeaking` are updated exclusively from server signals — there is no client-side audio analysis in the SDK.

## Solution

Replace the server-mediated speaking detection with **client-side audio level analysis** using the Web Audio API's `AnalyserNode`. The same code applies uniformly to both local and remote participants:

- **Local participant:** Analyze the mic `MediaStreamTrack` directly — zero network latency.
- **Remote participants:** Analyze the received audio `MediaStreamTrack` (already decoded from WebRTC on the client) — detection fires at the same moment the audio is heard, achieving perfect audio-visual sync.

## Architecture

### New file: `features/voice/lib/speaking-detector.ts`

Single exported function:

```
createSpeakingDetector(
  audioContext: AudioContext,
  mediaStreamTrack: MediaStreamTrack,
  onChange: (isSpeaking: boolean) => void,
  options?: { threshold?: number; holdMs?: number; intervalMs?: number }
): () => void  // returns cleanup function
```

**Internal pipeline:**

```
MediaStreamTrack
  -> new MediaStream([track])
  -> audioContext.createMediaStreamSource(stream)
  -> AnalyserNode (fftSize: 2048)
  -> getFloatTimeDomainData() every intervalMs
  -> compute RMS
  -> compare to threshold
  -> onset: immediate onChange(true)
  -> offset: after holdMs of silence, onChange(false)
```

The `AnalyserNode` is passive (read-only) — it does not modify the audio signal, so playback through `<audio>` elements is unaffected.

### Default parameters

| Parameter    | Default  | Rationale                                                    |
| ------------ | -------- | ------------------------------------------------------------ |
| `threshold`  | `0.01`   | Catches quiet speech. LiveKit server threshold is ~0.03-0.05 |
| `holdMs`     | `150`    | Short enough to not trail, long enough to bridge word gaps    |
| `intervalMs` | `50`     | 20 polls/sec — responsive feel, negligible CPU               |

### Integration in `voice-connection-store.ts`

**New module-level state** (same pattern as `krispProcessorRef`):

```
let speakerDetectorCleanups: Map<string, () => void>  // participantIdentity -> cleanup
let sharedAudioContext: AudioContext | null
```

**Event wiring in `registerRoomEvents()`:**

- `RoomEvent.LocalTrackPublished` (source === Microphone): Create detector for local participant. `onChange(true)` adds identity to `activeSpeakers` and sets `hasSpokenSinceLastHeartbeat = true`. `onChange(false)` removes identity.
- `RoomEvent.TrackSubscribed` (kind === Audio): Create detector for remote participant. `onChange` adds/removes identity from `activeSpeakers`.
- `RoomEvent.TrackUnsubscribed` (kind === Audio): Call cleanup for that participant's detector.
- `RoomEvent.LocalTrackUnpublished` (source === Microphone): Call cleanup for local participant's detector.
- `RoomEvent.Disconnected`: Drain entire `speakerDetectorCleanups` map, close `sharedAudioContext`.

**Removal:** The existing `RoomEvent.ActiveSpeakersChanged` handler is removed entirely. The `hasSpokenSinceLastHeartbeat` flag is now set by the local participant's speaking detector callback.

**Incremental `activeSpeakers` update:** Instead of replacing the entire Set on each event (current behavior), add/remove one identity at a time. Skip Zustand update if the Set is already in the desired state (same optimization as current set-equality check).

### CSS transition tuning in `voice-participant-list.tsx`

Current: `transition-shadow duration-75` (symmetric 75ms).

Change to asymmetric transitions:
- **Onset:** `duration-0` (instant ring appearance)
- **Offset:** `duration-150` (gentle fade-out)

This complements the data-level fix with visual polish.

## Edge Cases

| Case                      | Behavior                                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| KRISP active              | `track.mediaStreamTrack` returns the post-KRISP processed track. Detection runs on clean audio.    |
| Local participant muted   | `stopMicTrackOnMute: false` keeps track alive but SDK mutes it. Track produces silence -> `false`. |
| AudioContext blocked       | Impossible in practice (user clicked "join"). If it fails: `logger.warn`, indicator stays inactive.|
| Device change             | `LocalTrackUnpublished` + `LocalTrackPublished` fires. Old detector cleaned up, new one created.   |
| Reconnect                 | `Disconnected` cleans up everything. New tracks published after reconnect create new detectors.    |
| Track replacement (remote)| `TrackUnsubscribed` + `TrackSubscribed` fires. Same cleanup/create cycle.                          |

## Files Changed

| File                                        | Action   | ~Lines |
| ------------------------------------------- | -------- | ------ |
| `features/voice/lib/speaking-detector.ts`   | New      | ~35    |
| `features/voice/stores/voice-connection-store.ts` | Modify | ~30    |
| `features/voice/components/voice-participant-list.tsx` | Modify | ~3  |
| `features/voice/stores/voice-connection-store.test.ts` | Modify | ~40 |

## What This Does NOT Change

- **Heartbeat mechanism:** Still fires at the same interval. Only the source of `hasSpokenSinceLastHeartbeat` changes (client-side detector vs server event).
- **SSE voice state updates:** `useRealtimeVoice` (join/leave/mute/deafen) is unaffected.
- **Voice connection lifecycle:** `connect()`, `disconnect()`, `reset()` logic unchanged beyond cleanup hooks.
- **KRISP pipeline:** Completely independent. The detector reads from the track; KRISP processes the track. No interaction.

## Expected Improvement

| Metric                | Before (server)   | After (client-side) |
| --------------------- | ----------------- | ------------------- |
| Onset latency (local) | ~200-400ms        | ~50ms               |
| Onset latency (remote)| ~200-400ms        | ~50ms (synced with audio playback) |
| Offset latency        | ~300-500ms        | ~150ms (configurable holdMs)       |
| Quiet speech detected | No (server threshold too high) | Yes (threshold 0.01) |
