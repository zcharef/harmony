import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

const CLOSE_TO_TRAY_KEY = 'desktop_close_to_tray'

async function freshStore() {
  // WHY resetModules: hydration happens once at module init — each test needs
  // a store created against the current localStorage contents.
  vi.resetModules()
  const { useDesktopSettingsStore } = await import('./desktop-settings-store')
  return useDesktopSettingsStore
}

describe('desktop-settings-store', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('defaults closeToTray to ON when nothing is stored', async () => {
    const store = await freshStore()
    expect(store.getState().closeToTray).toBe(true)
  })

  it('hydrates a stored OFF value', async () => {
    localStorage.setItem(CLOSE_TO_TRAY_KEY, 'false')
    const store = await freshStore()
    expect(store.getState().closeToTray).toBe(false)
  })

  it('hydrates a stored ON value', async () => {
    localStorage.setItem(CLOSE_TO_TRAY_KEY, 'true')
    const store = await freshStore()
    expect(store.getState().closeToTray).toBe(true)
  })

  it('setCloseToTray(false) updates state and persists', async () => {
    const store = await freshStore()

    store.getState().setCloseToTray(false)

    expect(store.getState().closeToTray).toBe(false)
    expect(localStorage.getItem(CLOSE_TO_TRAY_KEY)).toBe('false')
  })

  it('setCloseToTray(true) round-trips back to ON', async () => {
    localStorage.setItem(CLOSE_TO_TRAY_KEY, 'false')
    const store = await freshStore()

    store.getState().setCloseToTray(true)

    expect(store.getState().closeToTray).toBe(true)
    expect(localStorage.getItem(CLOSE_TO_TRAY_KEY)).toBe('true')
  })
})
