# Client-Side Speaking Detector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace server-mediated speaking detection with client-side Web Audio API analysis for instant speaking indicators on all participants.

**Architecture:** A single utility function `createSpeakingDetector()` uses an `AnalyserNode` to poll audio levels from any `MediaStreamTrack` (local mic or remote audio). It fires a callback on speaking state changes, which the voice connection store uses to update the `activeSpeakers` Set incrementally. The existing `RoomEvent.ActiveSpeakersChanged` handler is removed.

**Tech Stack:** Web Audio API (`AudioContext`, `AnalyserNode`, `getFloatTimeDomainData`), LiveKit `Track.mediaStreamTrack`, Zustand, Vitest.

**Spec:** `docs/superpowers/specs/2026-04-13-client-side-speaking-detector-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `harmony-app/src/features/voice/lib/speaking-detector.ts` | **Create** | Pure utility: AudioContext → AnalyserNode → RMS polling → onChange callback |
| `harmony-app/src/features/voice/lib/speaking-detector.test.ts` | **Create** | Unit tests for the detector utility |
| `harmony-app/src/features/voice/stores/voice-connection-store.ts` | **Modify** | Wire detectors on track publish/subscribe, remove ActiveSpeakersChanged handler |
| `harmony-app/src/features/voice/stores/voice-connection-store.test.ts` | **Modify** | Replace ActiveSpeakersChanged tests with detector integration tests |
| `harmony-app/src/features/voice/components/voice-participant-list.tsx` | **Modify** | Asymmetric CSS transition on speaking ring |

---

## Task 1: Create `speaking-detector.ts` utility (TDD)

**Files:**
- Create: `harmony-app/src/features/voice/lib/speaking-detector.ts`
- Create: `harmony-app/src/features/voice/lib/speaking-detector.test.ts`

### Step 1.1: Write the failing tests

- [ ] Create `harmony-app/src/features/voice/lib/speaking-detector.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSpeakingDetector } from './speaking-detector'

// WHY: Web Audio API is not available in jsdom. We mock the minimal surface
// the detector actually uses: AudioContext, AnalyserNode, MediaStreamSource.
function createMockAudioContext() {
  const analyserNode = {
    fftSize: 0,
    frequencyBinCount: 1024,
    getFloatTimeDomainData: vi.fn(),
  }
  const sourceNode = { connect: vi.fn() }

  const ctx = {
    createAnalyser: vi.fn().mockReturnValue(analyserNode),
    createMediaStreamSource: vi.fn().mockReturnValue(sourceNode),
  } as unknown as AudioContext

  return { ctx, analyserNode, sourceNode }
}

function createMockMediaStreamTrack(): MediaStreamTrack {
  return { kind: 'audio', id: 'mock-track' } as unknown as MediaStreamTrack
}

/** WHY: Simulates audio level by filling the Float32Array buffer that
 * getFloatTimeDomainData receives. Values are -1.0 to 1.0 per Web Audio spec.
 * An amplitude of 0.0 everywhere = silence. */
function simulateAudioLevel(
  analyserNode: { getFloatTimeDomainData: ReturnType<typeof vi.fn> },
  amplitude: number,
) {
  analyserNode.getFloatTimeDomainData.mockImplementation((buffer: Float32Array) => {
    buffer.fill(amplitude)
  })
}

describe('createSpeakingDetector', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('calls onChange(true) when audio exceeds threshold', () => {
    const { ctx, analyserNode } = createMockAudioContext()
    const track = createMockMediaStreamTrack()
    const onChange = vi.fn()

    simulateAudioLevel(analyserNode, 0.0)
    createSpeakingDetector(ctx, track, onChange, { intervalMs: 50, threshold: 0.01 })

    // Start speaking
    simulateAudioLevel(analyserNode, 0.1)
    vi.advanceTimersByTime(50)

    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('calls onChange(false) after holdMs of silence', () => {
    const { ctx, analyserNode } = createMockAudioContext()
    const track = createMockMediaStreamTrack()
    const onChange = vi.fn()

    simulateAudioLevel(analyserNode, 0.1)
    createSpeakingDetector(ctx, track, onChange, {
      intervalMs: 50,
      threshold: 0.01,
      holdMs: 150,
    })

    // First tick: speaking detected
    vi.advanceTimersByTime(50)
    expect(onChange).toHaveBeenCalledWith(true)
    onChange.mockClear()

    // Stop speaking
    simulateAudioLevel(analyserNode, 0.0)

    // Advance past interval but before holdMs expires — should NOT call onChange(false)
    vi.advanceTimersByTime(50)
    expect(onChange).not.toHaveBeenCalledWith(false)

    // Advance past holdMs — NOW should call onChange(false)
    vi.advanceTimersByTime(100)
    expect(onChange).toHaveBeenCalledWith(false)
  })

  it('does not call onChange(true) for audio below threshold', () => {
    const { ctx, analyserNode } = createMockAudioContext()
    const track = createMockMediaStreamTrack()
    const onChange = vi.fn()

    simulateAudioLevel(analyserNode, 0.005) // below default 0.01
    createSpeakingDetector(ctx, track, onChange, { intervalMs: 50, threshold: 0.01 })

    vi.advanceTimersByTime(50)

    expect(onChange).not.toHaveBeenCalled()
  })

  it('does not duplicate onChange(true) on consecutive speaking ticks', () => {
    const { ctx, analyserNode } = createMockAudioContext()
    const track = createMockMediaStreamTrack()
    const onChange = vi.fn()

    simulateAudioLevel(analyserNode, 0.1)
    createSpeakingDetector(ctx, track, onChange, { intervalMs: 50, threshold: 0.01 })

    vi.advanceTimersByTime(50) // tick 1
    vi.advanceTimersByTime(50) // tick 2
    vi.advanceTimersByTime(50) // tick 3

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('resets hold timer when speech resumes during hold period', () => {
    const { ctx, analyserNode } = createMockAudioContext()
    const track = createMockMediaStreamTrack()
    const onChange = vi.fn()

    simulateAudioLevel(analyserNode, 0.1)
    createSpeakingDetector(ctx, track, onChange, {
      intervalMs: 50,
      threshold: 0.01,
      holdMs: 150,
    })

    // Start speaking
    vi.advanceTimersByTime(50)
    expect(onChange).toHaveBeenCalledWith(true)
    onChange.mockClear()

    // Brief silence (100ms < holdMs)
    simulateAudioLevel(analyserNode, 0.0)
    vi.advanceTimersByTime(100)

    // Resume speaking before holdMs expires
    simulateAudioLevel(analyserNode, 0.1)
    vi.advanceTimersByTime(50)

    // Should never have called onChange(false)
    expect(onChange).not.toHaveBeenCalledWith(false)
  })

  it('cleanup stops the polling interval', () => {
    const { ctx, analyserNode } = createMockAudioContext()
    const track = createMockMediaStreamTrack()
    const onChange = vi.fn()

    simulateAudioLevel(analyserNode, 0.0)
    const cleanup = createSpeakingDetector(ctx, track, onChange, { intervalMs: 50 })

    cleanup()

    simulateAudioLevel(analyserNode, 0.1)
    vi.advanceTimersByTime(200)

    expect(onChange).not.toHaveBeenCalled()
  })
})
```

### Step 1.2: Run tests to verify they fail

- [ ] Run:

```bash
cd harmony-app && npx vitest run src/features/voice/lib/speaking-detector.test.ts
```

Expected: FAIL — `Cannot find module './speaking-detector'`

### Step 1.3: Write the implementation

- [ ] Create `harmony-app/src/features/voice/lib/speaking-detector.ts`:

```typescript
/**
 * Client-side voice activity detector using Web Audio API.
 *
 * WHY: LiveKit's ActiveSpeakersChanged event is server-mediated (~200-400ms
 * latency). This utility analyzes audio locally via AnalyserNode for instant
 * onset (~50ms) and configurable offset, applied uniformly to both local mic
 * and remote audio tracks.
 */

const DEFAULT_THRESHOLD = 0.01
const DEFAULT_HOLD_MS = 150
const DEFAULT_INTERVAL_MS = 50

interface SpeakingDetectorOptions {
  /** RMS amplitude threshold to consider as speech. Default: 0.01 */
  threshold?: number
  /** Ms of silence before declaring not speaking. Default: 150 */
  holdMs?: number
  /** Polling interval in ms. Default: 50 */
  intervalMs?: number
}

/**
 * Monitors a MediaStreamTrack's audio level and fires onChange when the
 * speaking state transitions.
 *
 * @returns Cleanup function that stops polling and disconnects audio nodes.
 */
export function createSpeakingDetector(
  audioContext: AudioContext,
  mediaStreamTrack: MediaStreamTrack,
  onChange: (isSpeaking: boolean) => void,
  options?: SpeakingDetectorOptions,
): () => void {
  const threshold = options?.threshold ?? DEFAULT_THRESHOLD
  const holdMs = options?.holdMs ?? DEFAULT_HOLD_MS
  const intervalMs = options?.intervalMs ?? DEFAULT_INTERVAL_MS

  const analyser = audioContext.createAnalyser()
  analyser.fftSize = 2048

  const source = audioContext.createMediaStreamSource(new MediaStream([mediaStreamTrack]))
  source.connect(analyser)

  const buffer = new Float32Array(analyser.frequencyBinCount)
  let isSpeaking = false
  let holdTimer: ReturnType<typeof setTimeout> | null = null

  const interval = setInterval(() => {
    analyser.getFloatTimeDomainData(buffer)

    // WHY: RMS (root mean square) is the standard measure for audio signal
    // amplitude. Values in buffer are -1.0 to 1.0 per Web Audio spec.
    let sumSquares = 0
    for (let i = 0; i < buffer.length; i++) {
      sumSquares += buffer[i] * buffer[i]
    }
    const rms = Math.sqrt(sumSquares / buffer.length)

    if (rms > threshold) {
      // Speech detected — cancel any pending off-timer
      if (holdTimer !== null) {
        clearTimeout(holdTimer)
        holdTimer = null
      }
      if (!isSpeaking) {
        isSpeaking = true
        onChange(true)
      }
    } else if (isSpeaking && holdTimer === null) {
      // Silence detected while marked as speaking — start hold timer
      holdTimer = setTimeout(() => {
        holdTimer = null
        isSpeaking = false
        onChange(false)
      }, holdMs)
    }
  }, intervalMs)

  return () => {
    clearInterval(interval)
    if (holdTimer !== null) {
      clearTimeout(holdTimer)
    }
    source.disconnect()
  }
}
```

### Step 1.4: Run tests to verify they pass

- [ ] Run:

```bash
cd harmony-app && npx vitest run src/features/voice/lib/speaking-detector.test.ts
```

Expected: All 6 tests PASS.

### Step 1.5: Commit

- [ ] Run:

```bash
cd harmony-app && git add src/features/voice/lib/speaking-detector.ts src/features/voice/lib/speaking-detector.test.ts && git commit -m "$(cat <<'EOF'
feat(voice): add client-side speaking detector utility

Web Audio API AnalyserNode-based voice activity detection that replaces
server-mediated ActiveSpeakersChanged for instant speaking indicators.
EOF
)"
```

---

## Task 2: Integrate detector into voice-connection-store

**Files:**
- Modify: `harmony-app/src/features/voice/stores/voice-connection-store.ts`

### Step 2.1: Add module-level state and cleanup helper

- [ ] In `voice-connection-store.ts`, add the import and module-level variables after the existing `let hasSpokenSinceLastHeartbeat` block (after line 107):

```typescript
import { createSpeakingDetector } from '../lib/speaking-detector'
```

Add at line 11 (imports section), alongside the existing `livekit-client` imports. Then after the `hasSpokenSinceLastHeartbeat` block (after line 115):

```typescript
/** WHY: Stores per-participant detector cleanup functions. Keyed by
 * participant identity so TrackUnsubscribed / LocalTrackUnpublished can
 * clean up the exact detector without affecting others. Same lifecycle
 * pattern as roomEventCleanups. */
let speakerDetectorCleanups = new Map<string, () => void>()

/** WHY: Single AudioContext shared across all participant detectors to avoid
 * creating N contexts. Created lazily on first detector setup, closed on
 * disconnect/reset. Same module-level pattern as krispProcessorRef. */
let sharedAudioContext: AudioContext | null = null
```

Then add the helper functions after `removeRoomListeners()` (after line 151):

```typescript
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
```

### Step 2.2: Wire detectors in registerRoomEvents and remove ActiveSpeakersChanged

- [ ] In `registerRoomEvents()`, **remove** the entire `ActiveSpeakersChanged` handler (lines 263–286):

```typescript
  // DELETE THIS ENTIRE BLOCK (lines 263-286):
  onRoom(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
    // ... all of this ...
  })
```

- [ ] In the existing `TrackSubscribed` handler (lines 298–316), add the detector setup after the audio element is appended (after line 308, inside the `if (track.kind === Track.Kind.Audio)` block):

```typescript
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
```

- [ ] In the existing `TrackUnsubscribed` handler (lines 318–324), add detector cleanup inside the `if (track.kind === Track.Kind.Audio)` block, before the detach loop:

```typescript
      // WHY: Clean up speaking detector for this participant.
      const cleanup = speakerDetectorCleanups.get(/* need identity */)
```

**Problem:** `TrackUnsubscribed` callback doesn't receive the participant. We need to look up identity from the track. Since we key by identity, we need to also store the cleanup keyed differently. Actually, looking at the LiveKit SDK types, `TrackUnsubscribed` receives `(track, publication, participant)`. Let me check:

Actually, re-reading the existing handler at line 318: `onRoom(RoomEvent.TrackUnsubscribed, (track) => {` — it only destructures `track`. The full signature per LiveKit is `(track, publication, participant)`. We add the participant parameter:

Replace the existing `TrackUnsubscribed` handler (lines 318–324) with:

```typescript
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
```

- [ ] In the existing `LocalTrackPublished` handler (lines 334–349), add detector setup for the local participant. After the KRISP block (after line 349 but inside the same handler), add a new condition for mic track detection:

Actually, the existing handler already checks `trackPublication.source === Track.Source.Microphone`. We need to set up the detector for the local mic regardless of KRISP. Replace the entire handler (lines 334–349) with:

```typescript
  onRoom(RoomEvent.LocalTrackPublished, (trackPublication) => {
    if (
      trackPublication.source === Track.Source.Microphone &&
      trackPublication.track instanceof LocalAudioTrack
    ) {
      // WHY: KRISP attaches via LocalTrackPublished per LiveKit docs.
      if (get().isKrispEnabled) {
        attachKrispProcessor(trackPublication.track).catch((err: unknown) => {
          logger.warn('voice_krisp_init_failed', {
            error: err instanceof Error ? err.message : String(err),
          })
          set({ isKrispEnabled: false })
        })
      }

      // WHY: Client-side speaking detection for the local participant.
      // Uses mediaStreamTrack which returns post-KRISP audio when active.
      const audioCtx = getOrCreateAudioContext()
      if (audioCtx !== null) {
        const localIdentity = room.localParticipant.identity
        const detectorCleanup = createSpeakingDetector(
          audioCtx,
          trackPublication.track.mediaStreamTrack,
          (speaking) => {
            if (speaking) hasSpokenSinceLastHeartbeat = true
            updateSpeaker(localIdentity, speaking, get, set)
          },
        )
        speakerDetectorCleanups.set(localIdentity, detectorCleanup)
      }
    }
  })
```

- [ ] In the existing `LocalTrackUnpublished` handler (lines 327–329), add detector cleanup:

Replace (lines 327–329):

```typescript
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
```

### Step 2.3: Add cleanup to disconnect, reset, and Disconnected handler

- [ ] In the `Disconnected` event handler (inside `registerRoomEvents`, around line 222), add `cleanupAllSpeakerDetectors()` call right after `removeRoomListeners()`:

```typescript
    removeRoomListeners()
    cleanupAllSpeakerDetectors()
```

- [ ] In `teardownOldRoom()` (around line 415), add `cleanupAllSpeakerDetectors()` after `removeRoomListeners()`:

```typescript
  removeRoomListeners()
  cleanupAllSpeakerDetectors()
```

- [ ] In the `disconnect()` action (around line 487), add `cleanupAllSpeakerDetectors()` call after `krispProcessorRef = null`:

```typescript
    krispProcessorRef = null
    cleanupAllSpeakerDetectors()
```

- [ ] In the `reset()` action (around line 654), add `cleanupAllSpeakerDetectors()` call after `krispProcessorRef = null`:

```typescript
    krispProcessorRef = null
    cleanupAllSpeakerDetectors()
```

### Step 2.4: Clean up unused import

- [ ] Remove `Participant` from the `livekit-client` type imports (line 10) since `ActiveSpeakersChanged` handler that used it is gone:

```typescript
// Before:
import type { Participant, RoomOptions } from 'livekit-client'
// After:
import type { RoomOptions } from 'livekit-client'
```

### Step 2.5: Run typecheck

- [ ] Run:

```bash
cd harmony-app && npx tsc --noEmit
```

Expected: No errors.

### Step 2.6: Commit

- [ ] Run:

```bash
cd harmony-app && git add src/features/voice/stores/voice-connection-store.ts src/features/voice/lib/speaking-detector.ts && git commit -m "$(cat <<'EOF'
feat(voice): wire client-side speaking detectors into voice store

Replaces server-mediated ActiveSpeakersChanged with per-participant
AnalyserNode detectors for instant speaking indicators. Same code
path for local mic and remote audio tracks.
EOF
)"
```

---

## Task 3: Update store tests

**Files:**
- Modify: `harmony-app/src/features/voice/stores/voice-connection-store.test.ts`

### Step 3.1: Mock the speaking detector module

- [ ] Add a vi.mock for speaking-detector at the top of the test file, after the existing logger mock (after line 8):

```typescript
/** WHY: Mock speaking-detector so store tests don't need real AudioContext.
 * The detector's own tests cover its audio analysis logic. */
const mockDetectorCleanup = vi.fn()
vi.mock('../lib/speaking-detector', () => ({
  createSpeakingDetector: vi.fn().mockReturnValue(mockDetectorCleanup),
}))
```

### Step 3.2: Add AudioContext to globalThis mock

- [ ] After the speaking-detector mock, add a global AudioContext mock:

```typescript
/** WHY: voice-connection-store creates a shared AudioContext. jsdom doesn't
 * provide one. Minimal mock with the methods the store actually calls. */
globalThis.AudioContext = vi.fn().mockImplementation(() => ({
  close: vi.fn().mockResolvedValue(undefined),
  createAnalyser: vi.fn().mockReturnValue({
    fftSize: 0,
    frequencyBinCount: 1024,
    getFloatTimeDomainData: vi.fn(),
  }),
  createMediaStreamSource: vi.fn().mockReturnValue({ connect: vi.fn() }),
})) as unknown as typeof AudioContext
```

### Step 3.3: Update the RoomEvent mock to remove ActiveSpeakersChanged (optional — keep for backward compat)

Actually, keep the `ActiveSpeakersChanged` key in the mock RoomEvent enum — removing it would break any remaining references. It's just unused now.

### Step 3.4: Replace ActiveSpeakersChanged tests with detector integration tests

- [ ] Replace the `ActiveSpeakersChanged event` describe block (lines 920–945) with:

```typescript
    describe('speaking detector wiring', () => {
      it('creates a detector when a remote audio track is subscribed', async () => {
        const { createSpeakingDetector } = await import('../lib/speaking-detector')
        const room = await connectStore()

        const mockElement = document.createElement('audio')
        const mockTrack = {
          kind: 'audio',
          attach: vi.fn().mockReturnValue(mockElement),
          detach: vi.fn().mockReturnValue([]),
          mediaStreamTrack: { kind: 'audio', id: 'remote-track' },
        }
        const mockParticipant = { identity: 'remote-user', setVolume: vi.fn() }

        room.__emit('trackSubscribed', mockTrack, {}, mockParticipant)

        expect(createSpeakingDetector).toHaveBeenCalledWith(
          expect.anything(), // AudioContext
          mockTrack.mediaStreamTrack,
          expect.any(Function),
        )

        // Cleanup
        mockElement.remove()
      })

      it('cleans up detector when a remote audio track is unsubscribed', async () => {
        const room = await connectStore()

        const mockElement = document.createElement('audio')
        const mockTrack = {
          kind: 'audio',
          attach: vi.fn().mockReturnValue(mockElement),
          detach: vi.fn().mockReturnValue([mockElement]),
          mediaStreamTrack: { kind: 'audio', id: 'remote-track' },
        }
        const mockParticipant = { identity: 'remote-user', setVolume: vi.fn() }

        room.__emit('trackSubscribed', mockTrack, {}, mockParticipant)
        mockDetectorCleanup.mockClear()

        room.__emit('trackUnsubscribed', mockTrack, {}, mockParticipant)

        expect(mockDetectorCleanup).toHaveBeenCalled()
      })

      it('updates activeSpeakers when detector fires onChange', async () => {
        const { createSpeakingDetector: mockCreate } = await import('../lib/speaking-detector')
        const room = await connectStore()

        // Capture the onChange callback passed to createSpeakingDetector
        let capturedOnChange: ((speaking: boolean) => void) | undefined
        ;(mockCreate as ReturnType<typeof vi.fn>).mockImplementation(
          (_ctx: unknown, _track: unknown, onChange: (speaking: boolean) => void) => {
            capturedOnChange = onChange
            return vi.fn()
          },
        )

        const mockElement = document.createElement('audio')
        const mockTrack = {
          kind: 'audio',
          attach: vi.fn().mockReturnValue(mockElement),
          detach: vi.fn().mockReturnValue([]),
          mediaStreamTrack: { kind: 'audio', id: 'remote-track' },
        }
        const mockParticipant = { identity: 'alice', setVolume: vi.fn() }

        room.__emit('trackSubscribed', mockTrack, {}, mockParticipant)
        expect(capturedOnChange).toBeDefined()

        // Simulate speaking
        capturedOnChange!(true)
        expect(useVoiceConnectionStore.getState().activeSpeakers.has('alice')).toBe(true)

        // Simulate stop speaking
        capturedOnChange!(false)
        expect(useVoiceConnectionStore.getState().activeSpeakers.has('alice')).toBe(false)

        // Cleanup
        mockElement.remove()
      })
    })
```

### Step 3.5: Add mediaStreamTrack to existing TrackSubscribed test mocks

- [ ] In the existing `TrackSubscribed event` tests (around line 948), add `mediaStreamTrack` to mock tracks that are missing it. Find each `mockTrack` object in the `TrackSubscribed` and `TrackUnsubscribed` tests and add the property:

```typescript
        const mockTrack = {
          kind: 'audio',
          attach: vi.fn().mockReturnValue(mockElement),
          detach: vi.fn().mockReturnValue([]),
          mediaStreamTrack: { kind: 'audio', id: 'test-track' }, // ADD THIS
        }
```

Also add the `mockParticipant` parameter to `TrackUnsubscribed` test emissions where missing — the handler now expects 3 args:

```typescript
        // Before:
        room.__emit('trackUnsubscribed', mockTrack)
        // After:
        room.__emit('trackUnsubscribed', mockTrack, {}, { identity: 'remote-user' })
```

### Step 3.6: Run all voice store tests

- [ ] Run:

```bash
cd harmony-app && npx vitest run src/features/voice/stores/voice-connection-store.test.ts
```

Expected: All tests PASS.

### Step 3.7: Commit

- [ ] Run:

```bash
cd harmony-app && git add src/features/voice/stores/voice-connection-store.test.ts && git commit -m "$(cat <<'EOF'
test(voice): update store tests for client-side speaking detection

Replace ActiveSpeakersChanged tests with detector integration tests.
Mock createSpeakingDetector and AudioContext for jsdom environment.
EOF
)"
```

---

## Task 4: Asymmetric CSS transition on speaking ring

**Files:**
- Modify: `harmony-app/src/features/voice/components/voice-participant-list.tsx`

### Step 4.1: Update the Avatar transition classes

- [ ] In `voice-participant-list.tsx`, replace the Avatar `base` className (line 76–79):

Before:
```typescript
          base: cn(
            'h-6 w-6 shrink-0 transition-shadow duration-75',
            isSpeaking && 'ring-2 ring-success ring-offset-1 ring-offset-default-100',
          ),
```

After:
```typescript
          base: cn(
            'h-6 w-6 shrink-0 transition-shadow',
            isSpeaking
              ? 'duration-0 ring-2 ring-success ring-offset-1 ring-offset-default-100'
              : 'duration-150',
          ),
```

### Step 4.2: Run typecheck and lint

- [ ] Run:

```bash
cd harmony-app && npx tsc --noEmit && npx biome check src/features/voice/components/voice-participant-list.tsx
```

Expected: No errors.

### Step 4.3: Commit

- [ ] Run:

```bash
cd harmony-app && git add src/features/voice/components/voice-participant-list.tsx && git commit -m "$(cat <<'EOF'
style(voice): asymmetric speaking indicator transition

Instant ring onset (duration-0) for snappy feedback, gentle fade-out
(duration-150) for smooth deactivation.
EOF
)"
```

---

## Task 5: Full quality wall

### Step 5.1: Run the full quality wall

- [ ] Run:

```bash
cd harmony-app && just wall
```

Expected: All checks pass (lint, typecheck, boundaries, circular deps, architecture tests, unit tests).

### Step 5.2: Fix any issues found

- [ ] If any check fails, fix the issue and re-run `just wall`.

### Step 5.3: Final commit (if any fixes were needed)

- [ ] If fixes were made:

```bash
cd harmony-app && git add -A && git commit -m "fix(voice): address quality wall findings"
```
