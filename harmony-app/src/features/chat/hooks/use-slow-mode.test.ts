import { act, renderHook } from '@testing-library/react'
import { vi } from 'vitest'
import { useSlowMode } from './use-slow-mode'

describe('useSlowMode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('returns disabled result when slowModeSeconds is 0', () => {
    const { result } = renderHook(() => useSlowMode(0, false))

    expect(result.current.isInCooldown).toBe(false)
    expect(result.current.remainingSeconds).toBe(0)

    // WHY: startCooldown should be a no-op when disabled — calling it must not
    // change state.
    act(() => {
      result.current.startCooldown()
    })

    expect(result.current.isInCooldown).toBe(false)
    expect(result.current.remainingSeconds).toBe(0)
  })

  it('returns disabled result when isAdmin is true', () => {
    const { result } = renderHook(() => useSlowMode(30, true))

    expect(result.current.isInCooldown).toBe(false)
    expect(result.current.remainingSeconds).toBe(0)

    // WHY: Admins are exempt server-side. The hook must reflect this by
    // returning the disabled result regardless of slowModeSeconds.
    act(() => {
      result.current.startCooldown()
    })

    expect(result.current.isInCooldown).toBe(false)
    expect(result.current.remainingSeconds).toBe(0)
  })

  it('startCooldown sets isInCooldown to true', () => {
    vi.useFakeTimers()

    const { result } = renderHook(() => useSlowMode(30, false))

    expect(result.current.isInCooldown).toBe(false)

    act(() => {
      result.current.startCooldown()
    })

    expect(result.current.isInCooldown).toBe(true)
    expect(result.current.remainingSeconds).toBe(30)

    vi.useRealTimers()
  })

  it('remainingSeconds decrements over time', () => {
    vi.useFakeTimers()

    const { result } = renderHook(() => useSlowMode(5, false))

    act(() => {
      result.current.startCooldown()
    })

    expect(result.current.remainingSeconds).toBe(5)

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(result.current.remainingSeconds).toBe(4)

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(result.current.remainingSeconds).toBe(3)

    // WHY: Advancing past the full cooldown should reset to 0 and clear cooldown.
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(result.current.remainingSeconds).toBe(0)
    expect(result.current.isInCooldown).toBe(false)

    vi.useRealTimers()
  })

  it('channel switch resets cooldown', () => {
    vi.useFakeTimers()

    let slowModeSeconds = 30
    const { result, rerender } = renderHook(() => useSlowMode(slowModeSeconds, false))

    // Start a cooldown on the first channel
    act(() => {
      result.current.startCooldown()
    })

    expect(result.current.isInCooldown).toBe(true)
    expect(result.current.remainingSeconds).toBe(30)

    // WHY: Switching channels changes slowModeSeconds. The previous channel's
    // cooldown must not bleed into the new one.
    slowModeSeconds = 10
    rerender()

    expect(result.current.isInCooldown).toBe(false)
    expect(result.current.remainingSeconds).toBe(0)

    vi.useRealTimers()
  })
})
