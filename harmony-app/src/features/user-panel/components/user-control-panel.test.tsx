import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// WHY side-effect import: initializes the real i18n instance so the voice /
// channels / settings namespace keys resolve to text.
import '@/lib/i18n'

// WHY: The repo uses data-test (not data-testid).
configure({ testIdAttribute: 'data-test' })

// WHY: HeroUI overlays measure with ResizeObserver, absent from jsdom.
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
)

const toggleMute = vi.fn()
const toggleDeafen = vi.fn()
const openUserSettings = vi.fn()

// WHY: the store is driven via a selector stub — the panel only reads the
// mute/deafen flags and the two toggles.
const voiceState = { isMuted: false, isDeafened: false, toggleMute, toggleDeafen }
vi.mock('@/features/voice', () => ({
  useVoiceConnectionStore: (selector: (s: typeof voiceState) => unknown) => selector(voiceState),
  // WHY: a marker double so the test can assert the popover renders the
  // single-kind selector without pulling in real LiveKit device enumeration.
  AudioDeviceSelector: ({ kind }: { kind: string }) => (
    <div data-test={`mock-device-selector-${kind}`} />
  ),
}))

vi.mock('@/features/auth', () => ({
  useAuthStore: (selector: (s: { user: { id: string } }) => unknown) =>
    selector({ user: { id: 'user-1' } }),
  useCurrentProfile: () => ({
    data: { displayName: 'Zayed', username: 'zcharef', avatarUrl: null },
  }),
}))

vi.mock('@/features/presence', () => ({
  useUserStatus: () => 'online',
  StatusIndicator: () => <div data-test="mock-status-indicator" />,
}))

vi.mock('@/features/preferences', () => ({
  StatusPicker: ({ children }: { children: ReactNode }) => (
    <div data-test="mock-status-picker">{children}</div>
  ),
}))

vi.mock('@/features/settings', () => ({
  useSettingsUiStore: (selector: (s: { openUserSettings: () => void }) => unknown) =>
    selector({ openUserSettings }),
}))

const { UserControlPanel } = await import('./user-control-panel')

beforeEach(() => {
  vi.clearAllMocks()
  voiceState.isMuted = false
  voiceState.isDeafened = false
})

describe('UserControlPanel — disconnected (room === null)', () => {
  it('renders mute, deafen, both device chevrons, and the gear', () => {
    render(<UserControlPanel />)

    expect(screen.getByTestId('user-control-panel')).toBeTruthy()
    expect(screen.getByTestId('voice-mute-btn')).toBeTruthy()
    expect(screen.getByTestId('voice-deafen-btn')).toBeTruthy()
    expect(screen.getByTestId('voice-input-device-chevron')).toBeTruthy()
    expect(screen.getByTestId('voice-output-device-chevron')).toBeTruthy()
    expect(screen.getByTestId('user-settings-button')).toBeTruthy()
  })

  it('toggles mute and deafen when their buttons are pressed (works pre-call)', () => {
    render(<UserControlPanel />)

    fireEvent.click(screen.getByTestId('voice-mute-btn'))
    expect(toggleMute).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTestId('voice-deafen-btn'))
    expect(toggleDeafen).toHaveBeenCalledTimes(1)
  })

  it('opens the gear to user settings', () => {
    render(<UserControlPanel />)

    fireEvent.click(screen.getByTestId('user-settings-button'))
    expect(openUserSettings).toHaveBeenCalledTimes(1)
  })

  it('renders the name/status block left-aligned and stacked', () => {
    render(<UserControlPanel />)

    const nameSpan = screen.getByText('Zayed')
    const block = nameSpan.parentElement
    expect(block).not.toBeNull()
    // Left-aligned + vertical stack (avatar-name-status Discord layout).
    expect(block?.className).toContain('text-left')
    expect(block?.className).toContain('flex-col')
    // The status label is stacked under the name in the same block.
    expect(block?.textContent).toContain('Online')
  })
})

describe('UserControlPanel — device chevrons', () => {
  it('opens the input-device popover with the single-kind selector', async () => {
    render(<UserControlPanel />)

    expect(screen.queryByTestId('mock-device-selector-audioinput')).toBeNull()

    fireEvent.click(screen.getByTestId('voice-input-device-chevron'))

    await waitFor(() => {
      expect(screen.getByTestId('mock-device-selector-audioinput')).toBeTruthy()
    })
    // The output selector is NOT in the input popover.
    expect(screen.queryByTestId('mock-device-selector-audiooutput')).toBeNull()
  })

  it('opens the output-device popover with the single-kind selector', async () => {
    render(<UserControlPanel />)

    fireEvent.click(screen.getByTestId('voice-output-device-chevron'))

    await waitFor(() => {
      expect(screen.getByTestId('mock-device-selector-audiooutput')).toBeTruthy()
    })
  })
})
