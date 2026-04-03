import { useCallback, useEffect, useRef, useState } from 'react'

// WHY noop outside: Stable reference avoids re-renders when slow mode is disabled.
const noop = () => {}

interface SlowModeResult {
  /** Whether the user is currently in cooldown */
  isInCooldown: boolean
  /** Seconds remaining (0 when not in cooldown) */
  remainingSeconds: number
  /** Call after a successful message send to start the cooldown timer */
  startCooldown: () => void
  /** Call when receiving a 429 to sync with server-side remaining time */
  syncFromServer: (serverRemainingSeconds: number) => void
}

const DISABLED_RESULT: SlowModeResult = {
  isInCooldown: false,
  remainingSeconds: 0,
  startCooldown: noop,
  syncFromServer: noop,
}

/**
 * Tracks slow-mode cooldown for the chat input.
 *
 * WHY client-side countdown: Provides instant UX feedback (disabled input + seconds
 * remaining) without waiting for the server to reject each attempt with 429.
 * The server remains authoritative — `syncFromServer` re-aligns the client timer
 * if the server disagrees (e.g. after a page refresh mid-cooldown).
 */
export function useSlowMode(slowModeSeconds: number, isAdmin: boolean): SlowModeResult {
  // WHY early return: Admins are exempt server-side, and channels with slowModeSeconds === 0
  // have slow mode disabled. No state or timers needed — return a stable object.
  const [cooldownEnd, setCooldownEnd] = useState<number | null>(null)
  const [remainingSeconds, setRemainingSeconds] = useState(0)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // WHY: Clear any running interval to prevent timer leaks.
  const clearTick = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
  }, [])

  // WHY: Reset cooldown when slowModeSeconds changes (channel switch) to prevent
  // the previous channel's cooldown from bleeding into the new one.
  const prevSlowModeRef = useRef(slowModeSeconds)
  useEffect(() => {
    if (prevSlowModeRef.current !== slowModeSeconds) {
      clearTick()
      setCooldownEnd(null)
      setRemainingSeconds(0)
      prevSlowModeRef.current = slowModeSeconds
    }
  }, [slowModeSeconds, clearTick])

  // WHY: Interval ticks every second to update remainingSeconds from cooldownEnd.
  // Deriving from cooldownEnd (absolute timestamp) instead of decrementing a counter
  // avoids drift from setInterval jitter and survives tab-backgrounding correctly.
  useEffect(() => {
    if (cooldownEnd === null) {
      clearTick()
      setRemainingSeconds(0)
      return
    }

    const tick = () => {
      const secondsLeft = Math.max(0, Math.ceil((cooldownEnd - Date.now()) / 1000))
      setRemainingSeconds(secondsLeft)

      if (secondsLeft === 0) {
        clearTick()
        setCooldownEnd(null)
      }
    }

    // WHY: Immediate tick so the UI updates instantly when cooldown starts,
    // rather than waiting up to 1 second for the first interval fire.
    tick()
    intervalRef.current = setInterval(tick, 1000)

    return clearTick
  }, [cooldownEnd, clearTick])

  // WHY: Cleanup interval on unmount to prevent setState on unmounted component.
  useEffect(() => {
    return clearTick
  }, [clearTick])

  const startCooldown = useCallback(() => {
    setCooldownEnd(Date.now() + slowModeSeconds * 1000)
  }, [slowModeSeconds])

  const syncFromServer = useCallback((serverRemainingSeconds: number) => {
    setCooldownEnd(Date.now() + serverRemainingSeconds * 1000)
  }, [])

  if (slowModeSeconds === 0 || isAdmin === true) {
    return DISABLED_RESULT
  }

  return {
    isInCooldown: cooldownEnd !== null && remainingSeconds > 0,
    remainingSeconds,
    startCooldown,
    syncFromServer,
  }
}
