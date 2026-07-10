import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isAnyTabFocused, trackFocusLock } from './tab-coordination'

const FOCUS_LOCK_NAME = 'harmony:app-focused'

interface LocksStub {
  request: ReturnType<typeof vi.fn>
  query: ReturnType<typeof vi.fn>
}

function installLocksStub(heldNames: string[]): LocksStub {
  const stub: LocksStub = {
    request: vi.fn((_name: string, _opts: unknown, callback: () => Promise<void>) => callback()),
    query: vi.fn(async () => ({ held: heldNames.map((name) => ({ name })), pending: [] })),
  }
  Object.defineProperty(navigator, 'locks', {
    value: stub,
    writable: true,
    configurable: true,
  })
  return stub
}

function removeLocks() {
  Object.defineProperty(navigator, 'locks', {
    value: undefined,
    writable: true,
    configurable: true,
  })
}

describe('isAnyTabFocused', () => {
  afterEach(() => {
    removeLocks()
    vi.restoreAllMocks()
  })

  it('falls back to document.hasFocus() when Web Locks are unavailable', async () => {
    removeLocks()
    const hasFocusSpy = vi.spyOn(document, 'hasFocus')

    hasFocusSpy.mockReturnValue(true)
    await expect(isAnyTabFocused()).resolves.toBe(true)

    hasFocusSpy.mockReturnValue(false)
    await expect(isAnyTabFocused()).resolves.toBe(false)
  })

  it('returns true when a tab holds the focus lock', async () => {
    installLocksStub([FOCUS_LOCK_NAME])
    await expect(isAnyTabFocused()).resolves.toBe(true)
  })

  it('returns false when no tab holds the focus lock', async () => {
    installLocksStub(['some:other-lock'])
    await expect(isAnyTabFocused()).resolves.toBe(false)
  })
})

describe('trackFocusLock', () => {
  let stub: LocksStub

  beforeEach(() => {
    stub = installLocksStub([])
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
  })

  afterEach(() => {
    removeLocks()
    vi.restoreAllMocks()
  })

  it('acquires the lock on window focus and releases on blur', () => {
    const cleanup = trackFocusLock()
    expect(stub.request).not.toHaveBeenCalled()

    window.dispatchEvent(new Event('focus'))
    expect(stub.request).toHaveBeenCalledWith(
      FOCUS_LOCK_NAME,
      expect.objectContaining({ mode: 'exclusive', steal: true }),
      expect.any(Function),
    )

    // Blur then focus again — a NEW acquisition proves blur released the hold.
    window.dispatchEvent(new Event('blur'))
    window.dispatchEvent(new Event('focus'))
    expect(stub.request).toHaveBeenCalledTimes(2)

    cleanup()
  })

  it('acquires immediately when mounted in an already-focused tab', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const cleanup = trackFocusLock()
    expect(stub.request).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it('does not double-acquire on repeated focus events', () => {
    const cleanup = trackFocusLock()
    window.dispatchEvent(new Event('focus'))
    window.dispatchEvent(new Event('focus'))
    expect(stub.request).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it('is a no-op without Web Locks', () => {
    removeLocks()
    const cleanup = trackFocusLock()
    window.dispatchEvent(new Event('focus'))
    // No throw, nothing to assert on the API — the fallback path is
    // document.hasFocus() inside isAnyTabFocused().
    cleanup()
  })
})
