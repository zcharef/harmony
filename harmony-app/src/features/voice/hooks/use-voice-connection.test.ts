import { renderHook } from '@testing-library/react'
import { act } from 'react'
import { vi } from 'vitest'
import type { ProfileResponse, VoiceParticipantResponse } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { createQueryWrapper, createTestQueryClient } from '@/tests/test-utils'
import { useVoiceConnectionStore } from '../stores/voice-connection-store'
import { useVoiceConnection } from './use-voice-connection'

// -- Mocks ---------------------------------------------------------------------

const SELF_ID = '44444444-4444-4444-8444-444444444444'
const CHANNEL_ID = '11111111-1111-4111-8111-111111111111'
const SERVER_ID = 'server-1'
const SESSION_ID = 'session-xyz'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

vi.mock('../lib/voice-sounds', () => ({
  playVoiceSound: vi.fn(),
}))

// WHY: usePushToTalk registers a Tauri global shortcut on mount — a no-op mock
// keeps this hook test out of the native layer.
vi.mock('./use-push-to-talk', () => ({
  usePushToTalk: vi.fn(),
}))

// WHY: openUpgradeModal pulls the whole upgrade feature (HeroUI modal) — the
// hook only calls it on a plan-gate join error, never on the happy paths here.
vi.mock('@/features/upgrade', () => ({
  openUpgradeModal: vi.fn(),
}))

vi.mock('@/lib/voice-cleanup', () => ({
  fireAndForgetVoiceLeave: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  joinVoice: vi.fn(),
  leaveVoice: vi.fn(() => Promise.resolve({ data: undefined })),
  refreshVoiceToken: vi.fn(() => Promise.resolve({ data: undefined })),
  updateVoiceState: vi.fn(() => Promise.resolve({ data: undefined })),
  voiceHeartbeat: vi.fn(() => Promise.resolve({ data: undefined })),
}))

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(() =>
        Promise.resolve({
          data: { session: { access_token: 'tok', user: { id: SELF_ID } } },
        }),
      ),
      onAuthStateChange: vi.fn(() => ({
        data: { subscription: { unsubscribe: vi.fn() } },
      })),
    },
  },
}))

const { joinVoice, updateVoiceState } = await import('@/lib/api')

// -- Store harness -------------------------------------------------------------

const initialVoiceState = useVoiceConnectionStore.getState()

/**
 * WHY: The real store.connect() drives LiveKit (Room, mic, KRISP). This test
 * exercises the HOOK's post-join server-sync logic, not the transport, so we
 * replace connect with a mock that reproduces exactly the state transition the
 * real connect() commits: status → 'connected', and isMuted = micFailed ||
 * persistedMuted (isDeafened is never forced). See connect() in
 * voice-connection-store.ts (L936-945).
 */
let mockMicFailed = false

const mockConnect = vi.fn(async (channelId: string, serverId: string) => {
  const { isMuted, isDeafened } = useVoiceConnectionStore.getState()
  const nextMuted = mockMicFailed || isMuted
  useVoiceConnectionStore.setState({
    status: 'connected',
    room: null,
    currentChannelId: channelId,
    currentServerId: serverId,
    isMuted: nextMuted,
    isDeafened,
  })
})

function primeStore(overrides: { isMuted?: boolean; isDeafened?: boolean } = {}) {
  useVoiceConnectionStore.setState(initialVoiceState, true)
  useVoiceConnectionStore.setState({
    connect: mockConnect,
    status: 'idle',
    room: null,
    currentChannelId: null,
    currentServerId: null,
    isMuted: overrides.isMuted ?? false,
    isDeafened: overrides.isDeafened ?? false,
  })
}

function mockJoinResponse() {
  // WHY partial fixture: the hook only reads token/url/sessionId/ttlSecs/
  // previousChannelId; request/response meta is irrelevant. Cast through unknown
  // per ADR-035 (no `as any`).
  const response = {
    data: {
      token: 'lk-token',
      url: 'wss://livekit.test',
      sessionId: SESSION_ID,
      ttlSecs: 3600,
      previousChannelId: null,
    },
  } as unknown as Awaited<ReturnType<typeof joinVoice>>
  vi.mocked(joinVoice).mockResolvedValue(response)
}

// -- Tests ---------------------------------------------------------------------

describe('useVoiceConnection first-join server sync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    mockMicFailed = false
    mockJoinResponse()
  })

  afterEach(() => {
    vi.useRealTimers()
    useVoiceConnectionStore.setState(initialVoiceState, true)
  })

  it('pushes the pre-call mute intent once on join, then syncs the first unmute toggle', async () => {
    primeStore({ isMuted: true, isDeafened: false })

    const { result } = renderHook(() => useVoiceConnection(), {
      wrapper: createQueryWrapper(),
    })

    await act(async () => {
      await result.current.joinVoice(CHANNEL_ID, SERVER_ID)
    })

    // syncInitialVoiceState pushes the muted intent exactly once on join.
    expect(updateVoiceState).toHaveBeenCalledTimes(1)
    expect(updateVoiceState).toHaveBeenLastCalledWith({
      body: { sessionId: SESSION_ID, isMuted: true, isDeafened: false },
      throwOnError: true,
    })

    // REGRESSION: a user who joined pre-muted then unmutes must have that first
    // toggle synced to the server (and via SSE to every other client). The skip
    // guard must NOT swallow it — it was only ever armed for a value CHANGE.
    act(() => {
      result.current.toggleMute()
    })
    act(() => {
      vi.advanceTimersByTime(200)
    })

    expect(updateVoiceState).toHaveBeenCalledTimes(2)
    expect(updateVoiceState).toHaveBeenLastCalledWith({
      body: { sessionId: SESSION_ID, isMuted: false, isDeafened: false },
      throwOnError: true,
    })
  })

  it('does not push voice state on join when the user is unmuted and undeafened', async () => {
    primeStore({ isMuted: false, isDeafened: false })

    const { result } = renderHook(() => useVoiceConnection(), {
      wrapper: createQueryWrapper(),
    })

    await act(async () => {
      await result.current.joinVoice(CHANNEL_ID, SERVER_ID)
    })

    expect(updateVoiceState).not.toHaveBeenCalled()
  })

  it('seeds the participant cache with the store mute/deafen state, not a hardcoded false', async () => {
    primeStore({ isMuted: true, isDeafened: true })

    const queryClient = createTestQueryClient()
    // WHY partial fixture: insertSelfIntoParticipantCache only reads username.
    // Cast through unknown per ADR-035 (no `as any`).
    const profile = { username: 'me' } as unknown as ProfileResponse
    queryClient.setQueryData<ProfileResponse>(queryKeys.profiles.me(), profile)

    const { result } = renderHook(() => useVoiceConnection(), {
      wrapper: createQueryWrapper(queryClient),
    })

    await act(async () => {
      await result.current.joinVoice(CHANNEL_ID, SERVER_ID)
    })

    const participants = queryClient.getQueryData<VoiceParticipantResponse[]>(
      queryKeys.voice.participants(CHANNEL_ID),
    )
    expect(participants).toHaveLength(1)
    expect(participants?.[0]).toMatchObject({
      userId: SELF_ID,
      isMuted: true,
      isDeafened: true,
    })
  })

  it('arms the skip guard when the mic fails (isMuted flips false→true) so the effect does not double-send', async () => {
    // WHY: micFailed forces mute across connect — that IS a value change, so the
    // sync effect fires once. syncInitialVoiceState already pushed the muted
    // state, so the guard must swallow that single effect run (no duplicate).
    primeStore({ isMuted: false, isDeafened: false })
    mockMicFailed = true

    const { result } = renderHook(() => useVoiceConnection(), {
      wrapper: createQueryWrapper(),
    })

    await act(async () => {
      await result.current.joinVoice(CHANNEL_ID, SERVER_ID)
    })

    // Flush any pending debounce the (skipped) effect might have scheduled.
    act(() => {
      vi.advanceTimersByTime(200)
    })

    // Exactly one push — from syncInitialVoiceState, not the effect.
    expect(updateVoiceState).toHaveBeenCalledTimes(1)
    expect(updateVoiceState).toHaveBeenLastCalledWith({
      body: { sessionId: SESSION_ID, isMuted: true, isDeafened: false },
      throwOnError: true,
    })
  })
})
