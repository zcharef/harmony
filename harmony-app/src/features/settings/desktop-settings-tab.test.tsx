import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
// WHY side-effect import: initializes the real i18n instance so labels
// resolve to actual translations (same pattern as chat-area.test.tsx).
import '@/lib/i18n'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

const autostartMocks = vi.hoisted(() => ({
  isEnabled: vi.fn(async () => false),
  enable: vi.fn(async () => undefined),
  disable: vi.fn(async () => undefined),
}))

vi.mock('@tauri-apps/plugin-autostart', () => autostartMocks)

const { useDesktopSettingsStore } = await import('./stores/desktop-settings-store')
const { DesktopSettingsTab } = await import('./desktop-settings-tab')

configure({ testIdAttribute: 'data-test' })

/** HeroUI Switch renders data-test on the label — the real control is the inner checkbox. */
function switchInput(testId: string): HTMLInputElement {
  const input = screen.getByTestId(testId).querySelector('input[type="checkbox"]')
  if (input === null) throw new Error(`no checkbox input inside ${testId}`)
  return input as HTMLInputElement
}

describe('DesktopSettingsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    useDesktopSettingsStore.setState({ closeToTray: true })
    autostartMocks.isEnabled.mockResolvedValue(false)
    autostartMocks.enable.mockResolvedValue(undefined)
    autostartMocks.disable.mockResolvedValue(undefined)
  })

  it('close-to-tray switch reflects the store and toggles it', async () => {
    render(<DesktopSettingsTab />)

    const input = switchInput('desktop-close-to-tray-switch')
    expect(input.checked).toBe(true)

    fireEvent.click(input)

    await waitFor(() => expect(useDesktopSettingsStore.getState().closeToTray).toBe(false))
    expect(localStorage.getItem('desktop_close_to_tray')).toBe('false')
  })

  it('autostart defaults OFF and reads the OS state on mount', async () => {
    autostartMocks.isEnabled.mockResolvedValue(true)
    render(<DesktopSettingsTab />)

    // Before the plugin answers, the switch must not claim it is enabled.
    expect(switchInput('desktop-autostart-switch').checked).toBe(false)

    await waitFor(() => expect(switchInput('desktop-autostart-switch').checked).toBe(true))
    expect(autostartMocks.isEnabled).toHaveBeenCalledTimes(1)
  })

  it('turning autostart on calls enable()', async () => {
    render(<DesktopSettingsTab />)
    await waitFor(() => expect(switchInput('desktop-autostart-switch').disabled).toBe(false))

    fireEvent.click(switchInput('desktop-autostart-switch'))

    await waitFor(() => expect(autostartMocks.enable).toHaveBeenCalledTimes(1))
    expect(autostartMocks.disable).not.toHaveBeenCalled()
    expect(switchInput('desktop-autostart-switch').checked).toBe(true)
  })

  it('turning autostart off calls disable()', async () => {
    autostartMocks.isEnabled.mockResolvedValue(true)
    render(<DesktopSettingsTab />)
    await waitFor(() => expect(switchInput('desktop-autostart-switch').checked).toBe(true))

    fireEvent.click(switchInput('desktop-autostart-switch'))

    await waitFor(() => expect(autostartMocks.disable).toHaveBeenCalledTimes(1))
    expect(switchInput('desktop-autostart-switch').checked).toBe(false)
  })

  it('rolls the switch back and shows an inline error when enable() fails', async () => {
    autostartMocks.enable.mockRejectedValue(new Error('denied'))
    render(<DesktopSettingsTab />)
    await waitFor(() => expect(switchInput('desktop-autostart-switch').disabled).toBe(false))

    fireEvent.click(switchInput('desktop-autostart-switch'))

    await waitFor(() => expect(screen.getByTestId('desktop-autostart-error')).toBeTruthy())
    expect(switchInput('desktop-autostart-switch').checked).toBe(false)
  })
})
