import type { User } from '@supabase/supabase-js'
import { renderHook } from '@testing-library/react'
import type { Room } from 'livekit-client'
import { act } from 'react'
import { vi } from 'vitest'
import { SSE_EVENT_PREFIX } from '@/hooks/use-server-event'
import type { VoiceParticipantResponse } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { createQueryWrapper, createTestQueryClient } from '@/tests/test-utils'
import { useVoiceConnectionStore } from '../stores/voice-connection-store'
import { useRealtimeVoice } from './use-realtime-voice'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

vi.mock('../lib/voice-sounds', () => ({
  playVoiceSound: vi.fn(),
}))

// WHY mock the auth barrel: the hook only reads useAuthStore.getState().user?.id.
// Importing the real barrel would pull the entire auth feature (supabase client,
// Sentry, login screens) into this test.
vi.mock('@/features/auth', () => {
  const state: { user: { id: string } | null } = { user: null }
  const useAuthStore = (selector: (s: typeof state) => unknown) => selector(state)
  useAuthStore.getState = () => state
  useAuthStore.setState = (partial: Partial<typeof state>) => Object.assign(state, partial)
  return { useAuthStore }
})

const { logger } = await import('@/lib/logger')
const { useAuthStore } = await import('@/features/auth')

const DEBOUNCE_MS = 500
const SERVER_ID = 'server-1'
const CHANNEL_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_CHANNEL_ID = '22222222-2222-4222-8222-222222222222'
const USER_A = '33333333-3333-4333-8333-333333333333'
const SELF_ID = '44444444-4444-4444-8444-444444444444'

const initialVoiceState = useVoiceConnectionStore.getState()

// -- Helpers -------------------------------------------------------------------

/**
 * WHY gcTime Infinity: these tests run under fake timers. With the house
 * default gcTime 0, advanceTimersByTime() garbage-collects the seeded,
 * unobserved participants cache BEFORE the 500ms debounce flush runs — the
 * batch would then apply against a fresh cache and mask regressions.
 */
function createVoiceQueryClient() {
  const queryClient = createTestQueryClient()
  queryClient.setDefaultOptions({
    queries: { retry: false, gcTime: Number.POSITIVE_INFINITY },
  })
  return queryClient
}

function buildParticipant(
  overrides: Partial<VoiceParticipantResponse> = {},
): VoiceParticipantResponse {
  return {
    channelId: CHANNEL_ID,
    userId: USER_A,
    displayName: 'alice',
    joinedAt: '2026-04-05T00:00:00.000Z',
    isMuted: false,
    isDeafened: false,
    ...overrides,
  }
}

function buildVoiceEvent(overrides: Record<string, unknown> = {}) {
  return {
    serverId: SERVER_ID,
    channelId: CHANNEL_ID,
    userId: USER_A,
    action: 'joined',
    displayName: 'alice',
    ...overrides,
  }
}

function fireVoiceEvent(payload: unknown) {
  window.dispatchEvent(
    new CustomEvent(`${SSE_EVENT_PREFIX}voice.state_update`, { detail: payload }),
  )
}

function getParticipants(queryClient: ReturnType<typeof createTestQueryClient>) {
  return queryClient.getQueryData<VoiceParticipantResponse[]>(
    queryKeys.voice.participants(CHANNEL_ID),
  )
}

function flushDebounce() {
  act(() => {
    vi.advanceTimersByTime(DEBOUNCE_MS)
  })
}

// -- Tests ---------------------------------------------------------------------

describe('useRealtimeVoice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    useVoiceConnectionStore.setState(initialVoiceState, true)
    useAuthStore.setState({ user: null })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // -- Regression: ghost participant (reactivity-bug-triage 1.2) ----------------
  // SSE events arriving before the initial REST fetch completes must seed an
  // empty array instead of being silently dropped.

  it('seeds an uninitialized cache from a joined event', () => {
    const queryClient = createVoiceQueryClient()
    // Intentionally do NOT seed the participants cache.

    renderHook(() => useRealtimeVoice(CHANNEL_ID), {
      wrapper: createQueryWrapper(queryClient),
    })

    act(() => {
      fireVoiceEvent(buildVoiceEvent())
    })
    flushDebounce()

    const participants = getParticipants(queryClient)
    expect(participants).toHaveLength(1)
    expect(participants?.[0]).toMatchObject({
      channelId: CHANNEL_ID,
      userId: USER_A,
      displayName: 'alice',
      isMuted: false,
      isDeafened: false,
    })
  })

  it('collapses joined then left for the same user on an uninitialized cache to an empty list', () => {
    const queryClient = createVoiceQueryClient()

    renderHook(() => useRealtimeVoice(CHANNEL_ID), {
      wrapper: createQueryWrapper(queryClient),
    })

    act(() => {
      fireVoiceEvent(buildVoiceEvent({ action: 'joined' }))
      fireVoiceEvent(buildVoiceEvent({ action: 'left' }))
    })
    flushDebounce()

    expect(getParticipants(queryClient)).toEqual([])
  })

  // -- Regression: token-refresh re-join must not duplicate a participant -------

  it('does not duplicate a participant on a re-join event (token refresh)', () => {
    const queryClient = createVoiceQueryClient()
    queryClient.setQueryData(queryKeys.voice.participants(CHANNEL_ID), [buildParticipant()])

    renderHook(() => useRealtimeVoice(CHANNEL_ID), {
      wrapper: createQueryWrapper(queryClient),
    })

    act(() => {
      fireVoiceEvent(buildVoiceEvent({ action: 'joined' }))
    })
    flushDebounce()

    const participants = getParticipants(queryClient)
    expect(participants).toHaveLength(1)
    expect(participants?.[0]?.userId).toBe(USER_A)
  })

  it('keeps the participant when left and joined arrive in the same batch (refresh flap)', () => {
    const queryClient = createVoiceQueryClient()
    queryClient.setQueryData(queryKeys.voice.participants(CHANNEL_ID), [buildParticipant()])

    renderHook(() => useRealtimeVoice(CHANNEL_ID), {
      wrapper: createQueryWrapper(queryClient),
    })

    act(() => {
      fireVoiceEvent(buildVoiceEvent({ action: 'left' }))
      fireVoiceEvent(buildVoiceEvent({ action: 'joined' }))
    })
    flushDebounce()

    const participants = getParticipants(queryClient)
    expect(participants).toHaveLength(1)
    expect(participants?.[0]?.userId).toBe(USER_A)
  })

  // -- Regression: sweep race must not evict the locally connected user ---------

  it('ignores a left event for the locally connected user (sweep race guard)', () => {
    const queryClient = createVoiceQueryClient()
    const self = buildParticipant({ userId: SELF_ID, displayName: 'me' })
    queryClient.setQueryData(queryKeys.voice.participants(CHANNEL_ID), [self])

    useVoiceConnectionStore.setState({
      status: 'connected',
      currentChannelId: CHANNEL_ID,
      // WHY partial cast: the guard only reads room.localParticipant.identity.
      room: { localParticipant: { identity: SELF_ID } } as unknown as Room,
    })

    renderHook(() => useRealtimeVoice(CHANNEL_ID), {
      wrapper: createQueryWrapper(queryClient),
    })

    act(() => {
      fireVoiceEvent(buildVoiceEvent({ userId: SELF_ID, action: 'left', displayName: 'me' }))
    })
    flushDebounce()

    expect(getParticipants(queryClient)).toHaveLength(1)
    expect(logger.info).toHaveBeenCalledWith(
      'voice_self_left_event_ignored',
      expect.objectContaining({ userId: SELF_ID }),
    )
  })

  it('ignores a joined event for the local user (self-join handled by handleJoinVoice)', () => {
    const queryClient = createVoiceQueryClient()

    // WHY partial fixture cast: the guard only reads user.id. Same pattern as
    // mockUser in auth-store.test.ts.
    useAuthStore.setState({
      user: {
        id: SELF_ID,
        aud: 'authenticated',
        created_at: '2026-04-05T00:00:00.000Z',
        app_metadata: {},
        user_metadata: {},
      } as User,
    })

    renderHook(() => useRealtimeVoice(CHANNEL_ID), {
      wrapper: createQueryWrapper(queryClient),
    })

    act(() => {
      fireVoiceEvent(buildVoiceEvent({ userId: SELF_ID, action: 'joined', displayName: 'me' }))
    })
    flushDebounce()

    expect(getParticipants(queryClient)).toBeUndefined()
    expect(logger.info).toHaveBeenCalledWith(
      'voice_self_joined_event_ignored',
      expect.objectContaining({ userId: SELF_ID }),
    )
  })

  // -- Baseline behavior ---------------------------------------------------------

  it('removes a participant from a seeded cache on a left event', () => {
    const queryClient = createVoiceQueryClient()
    queryClient.setQueryData(queryKeys.voice.participants(CHANNEL_ID), [buildParticipant()])

    renderHook(() => useRealtimeVoice(CHANNEL_ID), {
      wrapper: createQueryWrapper(queryClient),
    })

    act(() => {
      fireVoiceEvent(buildVoiceEvent({ action: 'left' }))
    })
    flushDebounce()

    expect(getParticipants(queryClient)).toEqual([])
  })

  it('applies mute state updates to a seeded participant', () => {
    const queryClient = createVoiceQueryClient()
    queryClient.setQueryData(queryKeys.voice.participants(CHANNEL_ID), [buildParticipant()])

    renderHook(() => useRealtimeVoice(CHANNEL_ID), {
      wrapper: createQueryWrapper(queryClient),
    })

    act(() => {
      fireVoiceEvent(buildVoiceEvent({ action: 'muted', isMuted: true, isDeafened: false }))
    })
    flushDebounce()

    expect(getParticipants(queryClient)?.[0]?.isMuted).toBe(true)
  })

  it('ignores events for a different channel', () => {
    const queryClient = createVoiceQueryClient()

    renderHook(() => useRealtimeVoice(CHANNEL_ID), {
      wrapper: createQueryWrapper(queryClient),
    })

    act(() => {
      fireVoiceEvent(buildVoiceEvent({ channelId: OTHER_CHANNEL_ID }))
    })
    flushDebounce()

    expect(getParticipants(queryClient)).toBeUndefined()
  })

  it('warns and leaves the cache untouched on a malformed payload', () => {
    const queryClient = createVoiceQueryClient()

    renderHook(() => useRealtimeVoice(CHANNEL_ID), {
      wrapper: createQueryWrapper(queryClient),
    })

    act(() => {
      fireVoiceEvent({ channelId: CHANNEL_ID, action: 'joined' })
    })
    flushDebounce()

    expect(logger.warn).toHaveBeenCalledOnce()
    expect(getParticipants(queryClient)).toBeUndefined()
  })

  it('flushes buffered events on unmount so no update is lost', () => {
    const queryClient = createVoiceQueryClient()

    const { unmount } = renderHook(() => useRealtimeVoice(CHANNEL_ID), {
      wrapper: createQueryWrapper(queryClient),
    })

    act(() => {
      fireVoiceEvent(buildVoiceEvent())
    })
    // Unmount BEFORE the debounce timer fires.
    unmount()

    const participants = getParticipants(queryClient)
    expect(participants).toHaveLength(1)
    expect(participants?.[0]?.userId).toBe(USER_A)
  })
})
