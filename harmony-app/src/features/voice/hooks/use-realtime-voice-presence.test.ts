import { renderHook } from '@testing-library/react'
import { act } from 'react'
import { vi } from 'vitest'
import { SSE_EVENT_PREFIX } from '@/hooks/use-server-event'
import type { VoiceParticipantResponse } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { createQueryWrapper, createTestQueryClient } from '@/tests/test-utils'
import { useRealtimeVoicePresence } from './use-realtime-voice-presence'

const SERVER_ID = 'server-1'
const CHANNEL_A = '11111111-1111-4111-8111-111111111111'
const CHANNEL_B = '22222222-2222-4222-8222-222222222222'
const CHANNEL_C = '33333333-3333-4333-8333-333333333333'
const USER = '44444444-4444-4444-8444-444444444444'
const OTHER_USER = '55555555-5555-4555-8555-555555555555'

function buildParticipant(
  overrides: Partial<VoiceParticipantResponse> = {},
): VoiceParticipantResponse {
  return {
    channelId: CHANNEL_A,
    userId: USER,
    displayName: 'alice',
    joinedAt: '2026-04-05T00:00:00.000Z',
    isMuted: false,
    isDeafened: false,
    ...overrides,
  }
}

function fireJoined(channelId: string, userId: string) {
  window.dispatchEvent(
    new CustomEvent(`${SSE_EVENT_PREFIX}voice.state_update`, {
      detail: {
        serverId: SERVER_ID,
        channelId,
        userId,
        action: 'joined',
        displayName: 'alice',
      },
    }),
  )
}

function getParticipants(queryClient: ReturnType<typeof createTestQueryClient>, channelId: string) {
  return queryClient.getQueryData<VoiceParticipantResponse[]>(
    queryKeys.voice.participants(channelId),
  )
}

describe('useRealtimeVoicePresence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('evicts the user from another channel cache on a joined event, without that list being subscribed', () => {
    const queryClient = createTestQueryClient()
    // The user currently shows in channel A's roster (stale). Channel A's own
    // VoiceParticipantList is NOT mounted here — only this global hook runs.
    queryClient.setQueryData(queryKeys.voice.participants(CHANNEL_A), [buildParticipant()])

    renderHook(() => useRealtimeVoicePresence(), { wrapper: createQueryWrapper(queryClient) })

    act(() => {
      fireJoined(CHANNEL_B, USER)
    })

    expect(getParticipants(queryClient, CHANNEL_A)).toEqual([])
  })

  it('does not touch the joined channel own cache (that is the per-channel hook job)', () => {
    const queryClient = createTestQueryClient()
    const existing = [buildParticipant({ channelId: CHANNEL_B })]
    queryClient.setQueryData(queryKeys.voice.participants(CHANNEL_B), existing)

    renderHook(() => useRealtimeVoicePresence(), { wrapper: createQueryWrapper(queryClient) })

    act(() => {
      fireJoined(CHANNEL_B, USER)
    })

    // Same reference — the joined channel is skipped entirely.
    expect(getParticipants(queryClient, CHANNEL_B)).toBe(existing)
  })

  it('evicts the user from every other voice channel cache at once', () => {
    const queryClient = createTestQueryClient()
    queryClient.setQueryData(queryKeys.voice.participants(CHANNEL_A), [
      buildParticipant({ channelId: CHANNEL_A }),
    ])
    queryClient.setQueryData(queryKeys.voice.participants(CHANNEL_C), [
      buildParticipant({ channelId: CHANNEL_C }),
    ])

    renderHook(() => useRealtimeVoicePresence(), { wrapper: createQueryWrapper(queryClient) })

    act(() => {
      fireJoined(CHANNEL_B, USER)
    })

    expect(getParticipants(queryClient, CHANNEL_A)).toEqual([])
    expect(getParticipants(queryClient, CHANNEL_C)).toEqual([])
  })

  it('leaves other participants in the evicted channel untouched', () => {
    const queryClient = createTestQueryClient()
    queryClient.setQueryData(queryKeys.voice.participants(CHANNEL_A), [
      buildParticipant({ userId: USER, displayName: 'alice' }),
      buildParticipant({ userId: OTHER_USER, displayName: 'bob' }),
    ])

    renderHook(() => useRealtimeVoicePresence(), { wrapper: createQueryWrapper(queryClient) })

    act(() => {
      fireJoined(CHANNEL_B, USER)
    })

    const roster = getParticipants(queryClient, CHANNEL_A)
    expect(roster).toHaveLength(1)
    expect(roster?.[0]?.userId).toBe(OTHER_USER)
  })

  it('keeps the same cache reference when the user is absent (no needless re-render)', () => {
    const queryClient = createTestQueryClient()
    const roster = [buildParticipant({ userId: OTHER_USER })]
    queryClient.setQueryData(queryKeys.voice.participants(CHANNEL_A), roster)

    renderHook(() => useRealtimeVoicePresence(), { wrapper: createQueryWrapper(queryClient) })

    act(() => {
      fireJoined(CHANNEL_B, USER)
    })

    expect(getParticipants(queryClient, CHANNEL_A)).toBe(roster)
  })

  it('ignores non-joined actions', () => {
    const queryClient = createTestQueryClient()
    const roster = [buildParticipant()]
    queryClient.setQueryData(queryKeys.voice.participants(CHANNEL_A), roster)

    renderHook(() => useRealtimeVoicePresence(), { wrapper: createQueryWrapper(queryClient) })

    act(() => {
      window.dispatchEvent(
        new CustomEvent(`${SSE_EVENT_PREFIX}voice.state_update`, {
          detail: {
            serverId: SERVER_ID,
            channelId: CHANNEL_B,
            userId: USER,
            action: 'left',
            displayName: 'alice',
          },
        }),
      )
    })

    expect(getParticipants(queryClient, CHANNEL_A)).toBe(roster)
  })
})
