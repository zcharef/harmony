import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

vi.mock('@/lib/platform', () => ({
  isTauri: vi.fn(() => false),
}))

vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: vi.fn().mockResolvedValue(false),
  requestPermission: vi.fn().mockResolvedValue('granted'),
}))

const { logger } = await import('@/lib/logger')
const { isTauri } = await import('@/lib/platform')
const { useNotificationPermission } = await import('./use-notification-permission')

function stubNotification(permission: string) {
  const requestPermission = vi
    .fn()
    .mockResolvedValue(permission === 'default' ? 'granted' : permission)
  vi.stubGlobal('Notification', { permission, requestPermission })
  return { requestPermission }
}

describe('useNotificationPermission (web)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isTauri).mockReturnValue(false)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each(['granted', 'denied', 'default'] as const)('reports %s', (permission) => {
    stubNotification(permission)
    const { result } = renderHook(() => useNotificationPermission())
    expect(result.current.state).toBe(permission)
  })

  it('reports unsupported when window.Notification is absent', () => {
    vi.stubGlobal('Notification', undefined)
    const { result } = renderHook(() => useNotificationPermission())
    expect(result.current.state).toBe('unsupported')
  })

  it('re-checks on visibilitychange (unblock in site settings, no reload)', () => {
    const stub = stubNotification('default')
    const { result } = renderHook(() => useNotificationPermission())
    expect(result.current.state).toBe('default')

    // Simulate the user granting permission in another tab / site settings.
    vi.stubGlobal('Notification', {
      permission: 'granted',
      requestPermission: stub.requestPermission,
    })
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })

    expect(result.current.state).toBe('granted')
  })

  it('request() transitions the state and logs the explicit result', async () => {
    stubNotification('default')
    const { result } = renderHook(() => useNotificationPermission())

    let resolved: string | undefined
    await act(async () => {
      resolved = await result.current.request()
    })

    expect(resolved).toBe('granted')
    expect(result.current.state).toBe('granted')
    expect(logger.info).toHaveBeenCalledWith('notification_permission_result', {
      result: 'granted',
    })
  })

  it('request() resolves unsupported without crashing when Notification is absent', async () => {
    vi.stubGlobal('Notification', undefined)
    const { result } = renderHook(() => useNotificationPermission())

    let resolved: string | undefined
    await act(async () => {
      resolved = await result.current.request()
    })

    expect(resolved).toBe('unsupported')
  })

  it('never requests permission on mount (never-nag invariant)', () => {
    const stub = stubNotification('default')
    renderHook(() => useNotificationPermission())
    expect(stub.requestPermission).not.toHaveBeenCalled()
  })
})

describe('useNotificationPermission (Tauri)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isTauri).mockReturnValue(true)
  })

  it('resolves granted from the plugin check on mount', async () => {
    const { isPermissionGranted } = await import('@tauri-apps/plugin-notification')
    vi.mocked(isPermissionGranted).mockResolvedValueOnce(true)

    const { result } = renderHook(() => useNotificationPermission())
    await act(async () => {
      await Promise.resolve()
    })

    expect(result.current.state).toBe('granted')
  })

  it('request() delegates to the plugin', async () => {
    const { requestPermission } = await import('@tauri-apps/plugin-notification')
    vi.mocked(requestPermission).mockResolvedValue('granted')

    const { result } = renderHook(() => useNotificationPermission())
    // WHY flush first: the mount effect dynamic-imports the same mocked
    // module — vitest's module runner races on CONCURRENT dynamic imports of
    // one mock (returns undefined). Real browsers dedupe module loads, so
    // this only affects the test environment.
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    let resolved: string | undefined
    await act(async () => {
      resolved = await result.current.request()
    })

    expect(resolved).toBe('granted')
    expect(requestPermission).toHaveBeenCalledOnce()
  })
})
