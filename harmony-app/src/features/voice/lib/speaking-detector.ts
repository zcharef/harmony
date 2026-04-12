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
      // Speech detected — reset the hold timer on every speaking tick so the
      // offset countdown always begins from the last active speech sample.
      if (holdTimer !== null) {
        clearTimeout(holdTimer)
      }
      holdTimer = setTimeout(() => {
        holdTimer = null
        isSpeaking = false
        onChange(false)
      }, holdMs)

      if (!isSpeaking) {
        isSpeaking = true
        onChange(true)
      }
    }
    // Silence: hold timer is already running (or we were never speaking).
    // No action needed — the timer will fire after holdMs of no speech.
  }, intervalMs)

  return () => {
    clearInterval(interval)
    if (holdTimer !== null) {
      clearTimeout(holdTimer)
    }
    source.disconnect()
  }
}
