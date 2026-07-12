import { configure, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// WHY side-effect import: initializes the real i18n instance so voice
// namespace keys resolve to text (same pattern as member-list.test.tsx).
import '@/lib/i18n'

// WHY: The repo uses data-test (not data-testid).
configure({ testIdAttribute: 'data-test' })

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

// WHY: useVoiceConnection pulls supabase + the generated API client — none of
// it matters for rendering the status bar. Only leaveVoice is consumed.
const leaveVoiceMock = vi.fn()
vi.mock('../hooks/use-voice-connection', () => ({
  useVoiceConnection: () => ({ leaveVoice: leaveVoiceMock }),
}))

// WHY: The store module imports livekit-client at load time; the bar tests
// drive the store via setState and never touch a real Room.
vi.mock('livekit-client', () => {
  function MockRoom() {
    return {}
  }
  MockRoom.getLocalDevices = vi.fn().mockResolvedValue([])
  return {
    Room: MockRoom,
    RoomEvent: {},
    Track: { Kind: { Audio: 'audio' }, Source: { Microphone: 'microphone' } },
    LocalAudioTrack: class LocalAudioTrack {},
    DisconnectReason: {},
  }
})

const { useVoiceConnectionStore } = await import('../stores/voice-connection-store')
const { VoiceConnectionBar } = await import('./voice-connection-bar')

const initialState = useVoiceConnectionStore.getState()

beforeEach(() => {
  useVoiceConnectionStore.setState(initialState, true)
  vi.clearAllMocks()
})

function renderBar({ channelName = 'General', onRetry = vi.fn() } = {}) {
  render(<VoiceConnectionBar channelName={channelName} onRetry={onRetry} />)
  return { onRetry }
}

describe('VoiceConnectionBar connection state machine', () => {
  it('renders nothing when idle', () => {
    useVoiceConnectionStore.setState({ status: 'idle' })
    renderBar()

    expect(screen.queryByTestId('voice-connection-bar')).toBeNull()
  })

  it('shows the connecting state', () => {
    useVoiceConnectionStore.setState({ status: 'connecting' })
    renderBar()

    expect(screen.getByTestId('voice-connection-bar')).toBeTruthy()
    expect(screen.getByText('Connecting...')).toBeTruthy()
  })

  it('shows the reconnecting state with controls still available', () => {
    useVoiceConnectionStore.setState({ status: 'reconnecting' })
    renderBar()

    expect(screen.getByText('Reconnecting...')).toBeTruthy()
    // WHY: During auto-reconnect the user keeps the disconnect control —
    // never a dead UI while the room recovers.
    expect(screen.getByTestId('voice-disconnect-btn')).toBeTruthy()
  })

  it('shows the connected state with the channel name', () => {
    useVoiceConnectionStore.setState({ status: 'connected' })
    renderBar({ channelName: 'lounge' })

    expect(screen.getByText('Voice Connected')).toBeTruthy()
    expect(screen.getByText('lounge')).toBeTruthy()
    expect(screen.getByTestId('voice-disconnect-btn')).toBeTruthy()
  })

  it('shows the error detail and a retry action when failed', () => {
    useVoiceConnectionStore.setState({ status: 'failed', error: 'Voice limit reached' })
    const { onRetry } = renderBar()

    expect(screen.getByText('Voice limit reached')).toBeTruthy()

    fireEvent.click(screen.getByTestId('voice-retry-btn'))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('falls back to the translated failure message when error is null', () => {
    useVoiceConnectionStore.setState({ status: 'failed', error: null })
    renderBar()

    expect(screen.getByText('Connection failed')).toBeTruthy()
    expect(screen.getByText('Retry')).toBeTruthy()
  })

  it('shows timeout-specific copy and a retry action when the connect timed out', () => {
    useVoiceConnectionStore.setState({
      status: 'failed',
      error: null,
      connectFailureReason: 'timeout',
    })
    const { onRetry } = renderBar()

    expect(screen.getByText("Couldn't connect to voice")).toBeTruthy()

    fireEvent.click(screen.getByTestId('voice-retry-btn'))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('shows the disconnected state without controls', () => {
    useVoiceConnectionStore.setState({ status: 'disconnected' })
    renderBar()

    expect(screen.getByText('Disconnected')).toBeTruthy()
    expect(screen.queryByTestId('voice-disconnect-btn')).toBeNull()
  })
})

describe('VoiceConnectionBar device fallback notice', () => {
  it('shows the microphone fallback notice', () => {
    useVoiceConnectionStore.setState({ status: 'connected', deviceFallbacks: ['audioinput'] })
    renderBar()

    const notice = screen.getByTestId('voice-device-fallback-notice')
    expect(notice.textContent).toContain('Microphone disconnected')
  })

  it('shows the speaker fallback notice', () => {
    useVoiceConnectionStore.setState({ status: 'connected', deviceFallbacks: ['audiooutput'] })
    renderBar()

    const notice = screen.getByTestId('voice-device-fallback-notice')
    expect(notice.textContent).toContain('Speaker disconnected')
  })

  it('shows a combined notice when both devices fell back (USB headset unplug)', () => {
    useVoiceConnectionStore.setState({
      status: 'connected',
      deviceFallbacks: ['audioinput', 'audiooutput'],
    })
    renderBar()

    const notice = screen.getByTestId('voice-device-fallback-notice')
    expect(notice.textContent).toContain('Audio devices disconnected')
  })

  it('shows no notice when no fallback happened', () => {
    useVoiceConnectionStore.setState({ status: 'connected', deviceFallbacks: [] })
    renderBar()

    expect(screen.queryByTestId('voice-device-fallback-notice')).toBeNull()
  })
})
