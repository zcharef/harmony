import { act, configure, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// WHY side-effect import: initializes the real i18n instance so voice
// namespace keys resolve to text (same pattern as member-list.test.tsx).
import '@/lib/i18n'
import type { VoiceParticipantResponse } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { createQueryWrapper, createTestQueryClient } from '@/tests/test-utils'

// WHY: The repo uses data-test (not data-testid).
configure({ testIdAttribute: 'data-test' })

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

// WHY: The SSE bridge is exercised by use-realtime-voice.test.ts; here the
// participant cache IS the mocked presence source (seeded via setQueryData).
vi.mock('../hooks/use-realtime-voice', () => ({
  useRealtimeVoice: vi.fn(),
}))

// WHY: The store module imports livekit-client at load time; these tests
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
const { VoiceParticipantList } = await import('./voice-participant-list')

const initialState = useVoiceConnectionStore.getState()

const CHANNEL = '11111111-1111-4111-8111-111111111111'

function participant(overrides: Partial<VoiceParticipantResponse>): VoiceParticipantResponse {
  return {
    channelId: CHANNEL,
    userId: 'user-1',
    displayName: 'Alice',
    joinedAt: '2026-07-01T00:00:00Z',
    isMuted: false,
    isDeafened: false,
    ...overrides,
  }
}

function renderList(participants: VoiceParticipantResponse[]) {
  const queryClient = createTestQueryClient()
  queryClient.setQueryData(queryKeys.voice.participants(CHANNEL), participants)
  render(<VoiceParticipantList channelId={CHANNEL} serverId={null} />, {
    wrapper: createQueryWrapper(queryClient),
  })
  return queryClient
}

beforeEach(() => {
  useVoiceConnectionStore.setState(initialState, true)
  vi.clearAllMocks()
})

describe('VoiceParticipantList', () => {
  it('renders nothing when the channel is empty', () => {
    renderList([])

    expect(screen.queryByTestId('voice-participant-list')).toBeNull()
  })

  it('renders one row per participant with their name', () => {
    renderList([
      participant({ userId: 'user-1', displayName: 'Alice' }),
      participant({ userId: 'user-2', displayName: 'Bob' }),
    ])

    expect(screen.getByTestId('voice-participant-user-1')).toBeTruthy()
    expect(screen.getByTestId('voice-participant-user-2')).toBeTruthy()
    expect(screen.getByText('Alice')).toBeTruthy()
    expect(screen.getByText('Bob')).toBeTruthy()
  })

  it('shows the speaking ring only on active speakers', () => {
    useVoiceConnectionStore.setState({ activeSpeakers: new Set(['user-2']) })
    renderList([
      participant({ userId: 'user-1', displayName: 'Alice' }),
      participant({ userId: 'user-2', displayName: 'Bob' }),
    ])

    const silent = screen.getByTestId('voice-participant-user-1')
    const speaking = screen.getByTestId('voice-participant-user-2')
    expect(speaking.querySelector('.ring-success')).not.toBeNull()
    expect(silent.querySelector('.ring-success')).toBeNull()
  })

  it('shows the mute icon for a muted remote participant', () => {
    renderList([participant({ userId: 'user-1', isMuted: true })])

    expect(screen.getByTestId('mic-off-indicator')).toBeTruthy()
    expect(screen.queryByTestId('deaf-indicator')).toBeNull()
  })

  it('shows the deafen icon (taking precedence over mute) for a deafened participant', () => {
    renderList([participant({ userId: 'user-1', isMuted: true, isDeafened: true })])

    expect(screen.getByTestId('deaf-indicator')).toBeTruthy()
    expect(screen.queryByTestId('mic-off-indicator')).toBeNull()
  })

  it('shows no indicator for an unmuted participant', () => {
    renderList([participant({ userId: 'user-1' })])

    expect(screen.queryByTestId('mic-off-indicator')).toBeNull()
    expect(screen.queryByTestId('deaf-indicator')).toBeNull()
  })

  it('updates live when the participant cache changes (SSE-patched source)', async () => {
    const queryClient = renderList([participant({ userId: 'user-1', displayName: 'Alice' })])

    // Simulates what useRealtimeVoice does on a voice.state_update event.
    // WHY async act: TanStack Query notifies observers via a microtask.
    await act(async () => {
      queryClient.setQueryData<VoiceParticipantResponse[]>(queryKeys.voice.participants(CHANNEL), [
        participant({ userId: 'user-1', displayName: 'Alice' }),
        participant({ userId: 'user-3', displayName: 'Carol' }),
      ])
    })

    // WHY waitFor: TanStack Query notifies observers on a scheduled tick.
    await waitFor(() => {
      expect(screen.getByTestId('voice-participant-user-3')).toBeTruthy()
      expect(screen.getByText('Carol')).toBeTruthy()
    })
  })
})
