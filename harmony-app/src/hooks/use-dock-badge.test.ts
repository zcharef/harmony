import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

const badgeState = vi.hoisted(() => ({
  totalUnread: 0,
}))

vi.mock('@/features/channels', () => ({
  useTotalUnread: () => badgeState.totalUnread,
}))

vi.mock('@/lib/platform', () => ({
  isTauri: vi.fn(() => true),
  isWindows: vi.fn(() => false),
}))

const { setBadgeCount, setOverlayIcon } = vi.hoisted(() => ({
  setBadgeCount: vi.fn(async () => undefined),
  setOverlayIcon: vi.fn(async () => undefined),
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ setBadgeCount, setOverlayIcon }),
}))

vi.mock('@/lib/overlay-badge', () => ({
  renderOverlayBadgePng: vi.fn(),
}))

const { isTauri, isWindows } = await import('@/lib/platform')
const { renderOverlayBadgePng } = await import('@/lib/overlay-badge')
const { useDockBadge } = await import('./use-dock-badge')

describe('useDockBadge platform branches', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    badgeState.totalUnread = 0
    vi.mocked(isTauri).mockReturnValue(true)
    vi.mocked(isWindows).mockReturnValue(false)
  })

  it('does nothing outside Tauri', async () => {
    vi.mocked(isTauri).mockReturnValue(false)
    badgeState.totalUnread = 5

    renderHook(() => useDockBadge())

    // WHY flush: the badge update is async — give a rejected path a tick.
    await Promise.resolve()
    expect(setBadgeCount).not.toHaveBeenCalled()
    expect(setOverlayIcon).not.toHaveBeenCalled()
  })

  it('macOS: sets the badge count when unread > 0', async () => {
    badgeState.totalUnread = 3

    renderHook(() => useDockBadge())

    await waitFor(() => expect(setBadgeCount).toHaveBeenCalledExactlyOnceWith(3))
    expect(setOverlayIcon).not.toHaveBeenCalled()
  })

  it('macOS: clears the badge with undefined at 0 unread', async () => {
    badgeState.totalUnread = 0

    renderHook(() => useDockBadge())

    await waitFor(() => expect(setBadgeCount).toHaveBeenCalledExactlyOnceWith(undefined))
  })

  it('Windows: sets a generated overlay icon when unread > 0', async () => {
    vi.mocked(isWindows).mockReturnValue(true)
    const png = new Uint8Array([1, 2, 3])
    vi.mocked(renderOverlayBadgePng).mockReturnValue(png)
    badgeState.totalUnread = 4

    renderHook(() => useDockBadge())

    await waitFor(() => expect(setOverlayIcon).toHaveBeenCalledExactlyOnceWith(png))
    expect(renderOverlayBadgePng).toHaveBeenCalledExactlyOnceWith(4)
    expect(setBadgeCount).not.toHaveBeenCalled()
  })

  it('Windows: clears the overlay icon at 0 unread', async () => {
    vi.mocked(isWindows).mockReturnValue(true)
    badgeState.totalUnread = 0

    renderHook(() => useDockBadge())

    await waitFor(() => expect(setOverlayIcon).toHaveBeenCalledExactlyOnceWith(undefined))
    expect(renderOverlayBadgePng).not.toHaveBeenCalled()
    expect(setBadgeCount).not.toHaveBeenCalled()
  })

  it('Windows: keeps the previous overlay when icon generation fails', async () => {
    vi.mocked(isWindows).mockReturnValue(true)
    vi.mocked(renderOverlayBadgePng).mockReturnValue(null)
    badgeState.totalUnread = 9

    renderHook(() => useDockBadge())

    await waitFor(() => expect(renderOverlayBadgePng).toHaveBeenCalledExactlyOnceWith(9))
    expect(setOverlayIcon).not.toHaveBeenCalled()
    expect(setBadgeCount).not.toHaveBeenCalled()
  })
})
