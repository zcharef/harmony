import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactElement, ReactNode } from 'react'
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest'

// WHY side-effect import: initializes the real i18n instance so voice namespace
// keys (microphone/speaker labels) resolve to text.
import '@/lib/i18n'

// WHY: The repo uses data-test (not data-testid).
configure({ testIdAttribute: 'data-test' })

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

// WHY: HeroUI's Select renders a react-aria portal listbox with no hidden
// native <select>, so it cannot be driven deterministically in jsdom without
// user-event. Replace it (and SelectItem) with a plain native <select> that
// forwards onSelectionChange — the option values come from each SelectItem's
// React key (the deviceId), matching how the component builds the list. Every
// other @heroui/react export passes through unchanged.
vi.mock('@heroui/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@heroui/react')>()
  function MockSelect({
    children,
    onSelectionChange,
    'data-test': dataTest,
    'aria-label': ariaLabel,
  }: {
    children: ReactElement<{ children: ReactNode }>[]
    onSelectionChange: (keys: Set<string>) => void
    'data-test'?: string
    'aria-label'?: string
  }) {
    const items = Array.isArray(children) ? children : [children]
    return (
      <select
        data-test={dataTest}
        aria-label={ariaLabel}
        onChange={(e) => onSelectionChange(new Set([e.target.value]))}
      >
        <option value="" />
        {items.map((child) => (
          <option key={String(child.key)} value={String(child.key)}>
            {child.props.children}
          </option>
        ))}
      </select>
    )
  }
  return {
    ...actual,
    Select: MockSelect,
    SelectItem: ({ children }: { children: ReactNode }) => <>{children}</>,
  }
})

// WHY: The store module imports livekit-client at load time. Room.getLocalDevices
// is a STATIC enumeration that works room-less — the selector's whole point.
const INPUT_DEVICES = [
  { deviceId: 'mic-a', label: 'Mic A', kind: 'audioinput' },
  { deviceId: 'mic-b', label: 'Mic B', kind: 'audioinput' },
]
const OUTPUT_DEVICES = [{ deviceId: 'spk-a', label: 'Speaker A', kind: 'audiooutput' }]

vi.mock('livekit-client', () => {
  function MockRoom() {
    return {}
  }
  MockRoom.getLocalDevices = vi.fn((kind: string) =>
    Promise.resolve(kind === 'audioinput' ? INPUT_DEVICES : OUTPUT_DEVICES),
  )
  return {
    Room: MockRoom,
    RoomEvent: { MediaDevicesChanged: 'mediaDevicesChanged' },
    Track: { Kind: { Audio: 'audio' }, Source: { Microphone: 'microphone' } },
    LocalAudioTrack: class LocalAudioTrack {},
    DisconnectReason: {},
  }
})

const { useVoiceConnectionStore } = await import('../stores/voice-connection-store')
const { AudioDeviceSelector } = await import('./audio-device-selector')

const initialState = useVoiceConnectionStore.getState()

beforeEach(() => {
  localStorage.clear()
  useVoiceConnectionStore.setState(initialState, true)
  vi.clearAllMocks()
})

/** WHY: The mocked Select renders a native <select> keyed by data-test — a
 * change event exercises the component's onSelectionChange → switchDevice path. */
function selectNativeOption(dataTest: string, value: string) {
  const nativeSelect = screen.getByTestId(dataTest)
  fireEvent.change(nativeSelect, { target: { value } })
}

describe('AudioDeviceSelector — kind prop', () => {
  it('renders only the input select when kind="audioinput"', async () => {
    render(<AudioDeviceSelector kind="audioinput" />)

    await waitFor(() => {
      expect(screen.getByTestId('audio-input-select')).toBeTruthy()
    })
    expect(screen.queryByTestId('audio-output-select')).toBeNull()
  })

  it('renders only the output select when kind="audiooutput"', async () => {
    render(<AudioDeviceSelector kind="audiooutput" />)

    await waitFor(() => {
      expect(screen.getByTestId('audio-output-select')).toBeTruthy()
    })
    expect(screen.queryByTestId('audio-input-select')).toBeNull()
  })

  it('renders both selects when no kind is provided', async () => {
    render(<AudioDeviceSelector />)

    await waitFor(() => {
      expect(screen.getByTestId('audio-input-select')).toBeTruthy()
    })
    expect(screen.getByTestId('audio-output-select')).toBeTruthy()
  })
})

describe('AudioDeviceSelector — pre-call (room === null)', () => {
  it('renders (no longer guarded) even with no room', async () => {
    expect(useVoiceConnectionStore.getState().room).toBeNull()
    render(<AudioDeviceSelector kind="audioinput" />)

    await waitFor(() => {
      expect(screen.getByTestId('audio-input-select')).toBeTruthy()
    })
  })

  it('persists the choice without calling room.switchActiveDevice', async () => {
    render(<AudioDeviceSelector kind="audioinput" />)
    await waitFor(() => {
      expect(screen.getByTestId('audio-input-select')).toBeTruthy()
    })

    selectNativeOption('audio-input-select', 'mic-b')

    await waitFor(() => {
      expect(useVoiceConnectionStore.getState().preferredAudioInputId).toBe('mic-b')
    })
    expect(localStorage.getItem('voice_preferred_audio_input')).toBe('mic-b')
  })
})

describe('AudioDeviceSelector — connected (room present)', () => {
  function makeRoom() {
    return {
      switchActiveDevice: vi.fn().mockResolvedValue(undefined),
      getActiveDevice: vi.fn().mockReturnValue(undefined),
      on: vi.fn(),
      off: vi.fn(),
    }
  }

  it('switches the active device then persists the choice', async () => {
    const room = makeRoom()
    // WHY satisfies-free cast: the selector only touches this narrow surface.
    useVoiceConnectionStore.setState({ room: room as never })

    render(<AudioDeviceSelector kind="audioinput" />)
    await waitFor(() => {
      expect(screen.getByTestId('audio-input-select')).toBeTruthy()
    })

    selectNativeOption('audio-input-select', 'mic-b')

    await waitFor(() => {
      expect(room.switchActiveDevice as Mock).toHaveBeenCalledWith('audioinput', 'mic-b')
    })
    await waitFor(() => {
      expect(localStorage.getItem('voice_preferred_audio_input')).toBe('mic-b')
    })
  })
})
