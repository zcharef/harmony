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
  const sourceNode = { connect: vi.fn(), disconnect: vi.fn() }

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

// WHY: jsdom does not implement MediaStream. The detector wraps the track in
// one before passing to createMediaStreamSource, so we need a minimal stub.
// Using a regular function (not arrow) is required for `new MediaStream(...)` to work.
globalThis.MediaStream = vi.fn().mockImplementation(function (
  this: unknown,
  tracks: MediaStreamTrack[],
) {
  return { getTracks: () => tracks }
}) as unknown as typeof MediaStream

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

    // WHY: First silence tick starts the hold timer. Advance one interval
    // to trigger the silence detection, then check the timer hasn't fired.
    vi.advanceTimersByTime(50)
    expect(onChange).not.toHaveBeenCalledWith(false)

    // Advance past holdMs from the silence tick — NOW should call onChange(false)
    vi.advanceTimersByTime(150)
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

  it('cleanup stops the polling interval and disconnects source', () => {
    const { ctx, analyserNode, sourceNode } = createMockAudioContext()
    const track = createMockMediaStreamTrack()
    const onChange = vi.fn()

    simulateAudioLevel(analyserNode, 0.0)
    const cleanup = createSpeakingDetector(ctx, track, onChange, { intervalMs: 50 })

    cleanup()

    expect(sourceNode.disconnect).toHaveBeenCalled()

    simulateAudioLevel(analyserNode, 0.1)
    vi.advanceTimersByTime(200)

    expect(onChange).not.toHaveBeenCalled()
  })
})
