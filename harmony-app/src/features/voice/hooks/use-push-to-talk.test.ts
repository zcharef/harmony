import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

vi.mock('@/lib/platform', () => ({
  isTauri: vi.fn(() => true),
}))

const shortcutMocks = vi.hoisted(() => ({
  register: vi.fn(async () => undefined),
  unregister: vi.fn(async () => undefined),
}))

vi.mock('@tauri-apps/plugin-global-shortcut', () => shortcutMocks)

const { isTauri } = await import('@/lib/platform')
const { useVoiceConnectionStore } = await import('../stores/voice-connection-store')
const { usePushToTalk } = await import('./use-push-to-talk')

describe('usePushToTalk registration feedback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isTauri).mockReturnValue(true)
    shortcutMocks.register.mockResolvedValue(undefined)
    shortcutMocks.unregister.mockResolvedValue(undefined)
    useVoiceConnectionStore.setState({ pttRegisterError: null })
  })

  it('registers the shortcut and clears any previous error', async () => {
    useVoiceConnectionStore.setState({ pttRegisterError: 'F13' })

    renderHook(() => usePushToTalk('F13'))

    await waitFor(() =>
      expect(shortcutMocks.register).toHaveBeenCalledWith('F13', expect.any(Function)),
    )
    await waitFor(() => expect(useVoiceConnectionStore.getState().pttRegisterError).toBeNull())
  })

  it('surfaces the failed shortcut in the store when register() throws', async () => {
    shortcutMocks.register.mockRejectedValue(new Error('shortcut already taken'))

    renderHook(() => usePushToTalk('Alt+T'))

    await waitFor(() => expect(useVoiceConnectionStore.getState().pttRegisterError).toBe('Alt+T'))
  })

  it('unregisters on unmount', async () => {
    const { unmount } = renderHook(() => usePushToTalk('F13'))
    await waitFor(() => expect(shortcutMocks.register).toHaveBeenCalledTimes(1))

    unmount()

    await waitFor(() => expect(shortcutMocks.unregister).toHaveBeenCalledWith('F13'))
  })

  it('does nothing when the shortcut is null', async () => {
    renderHook(() => usePushToTalk(null))

    await Promise.resolve()
    expect(shortcutMocks.register).not.toHaveBeenCalled()
  })

  it('does nothing outside Tauri', async () => {
    vi.mocked(isTauri).mockReturnValue(false)

    renderHook(() => usePushToTalk('F13'))

    await Promise.resolve()
    expect(shortcutMocks.register).not.toHaveBeenCalled()
  })
})
