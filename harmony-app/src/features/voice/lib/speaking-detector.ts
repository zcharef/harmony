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
      // WHY: noUncheckedIndexedAccess makes this `number | undefined`.
      // Float32Array elements are always defined, but TS doesn't know that.
      const sample = buffer[i] ?? 0
      sumSquares += sample * sample
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
