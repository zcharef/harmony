import { act, configure, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

// WHY side-effect import: initializes the real i18n instance so voice
// namespace keys resolve to text (same pattern as member-list.test.tsx).
import '@/lib/i18n'
import type { VoiceParticipantResponse } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { createQueryWrapper, createTestQueryClient } from '@/tests/test-utils'
import { VoiceChannelOccupancy } from './voice-channel-occupancy'

// WHY: The repo uses data-test (not data-testid).
configure({ testIdAttribute: 'data-test' })

const CHANNEL = '22222222-2222-4222-8222-222222222222'

function participant(userId: string): VoiceParticipantResponse {
  return {
    channelId: CHANNEL,
    userId,
    displayName: userId,
    joinedAt: '2026-07-01T00:00:00Z',
    isMuted: false,
    isDeafened: false,
  }
}

function renderChip(participants: VoiceParticipantResponse[]) {
  const queryClient = createTestQueryClient()
  queryClient.setQueryData(queryKeys.voice.participants(CHANNEL), participants)
  render(<VoiceChannelOccupancy channelId={CHANNEL} />, {
    wrapper: createQueryWrapper(queryClient),
  })
  return queryClient
}

describe('VoiceChannelOccupancy', () => {
  it('renders nothing when the channel is empty', () => {
    renderChip([])

    expect(screen.queryByTestId('voice-channel-occupancy')).toBeNull()
  })

  it('shows the participant count', () => {
    renderChip([participant('user-1'), participant('user-2'), participant('user-3')])

    const chip = screen.getByTestId('voice-channel-occupancy')
    expect(chip.textContent).toContain('3')
  })

  it('updates live when the participant cache changes', async () => {
    const queryClient = renderChip([participant('user-1')])
    expect(screen.getByTestId('voice-channel-occupancy').textContent).toContain('1')

    // Simulates what useRealtimeVoice does on a voice.state_update event.
    // WHY async act: TanStack Query notifies observers via a microtask.
    await act(async () => {
      queryClient.setQueryData<VoiceParticipantResponse[]>(queryKeys.voice.participants(CHANNEL), [
        participant('user-1'),
        participant('user-2'),
      ])
    })

    // WHY waitFor: TanStack Query notifies observers on a scheduled tick.
    await waitFor(() => {
      expect(screen.getByTestId('voice-channel-occupancy').textContent).toContain('2')
    })
  })
})
