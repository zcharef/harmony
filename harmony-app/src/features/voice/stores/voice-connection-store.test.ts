import { type Mock, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks — must be declared before any import that touches the store module
// ---------------------------------------------------------------------------

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

/** WHY: Mock speaking-detector so store tests don't need real AudioContext.
 * The detector's own tests cover its audio analysis logic. */
const mockDetectorCleanup = vi.fn()
vi.mock('../lib/speaking-detector', () => ({
  createSpeakingDetector: vi.fn().mockReturnValue(mockDetectorCleanup),
}))

/** WHY: voice-connection-store creates a shared AudioContext. jsdom doesn't
 * provide one. Minimal mock with the methods the store actually calls. */
globalThis.AudioContext = vi.fn().mockImplementation(function (this: unknown) {
  return {
    close: vi.fn().mockResolvedValue(undefined),
    createAnalyser: vi.fn().mockReturnValue({
      fftSize: 0,
      frequencyBinCount: 1024,
      getFloatTimeDomainData: vi.fn(),
    }),
    createMediaStreamSource: vi.fn().mockReturnValue({ connect: vi.fn(), disconnect: vi.fn() }),
  }
}) as unknown as typeof AudioContext

/** WHY: Builds a fake Room that satisfies the surface the store uses.
 * Declared at module level so both the vi.mock factory and test helpers
 * can reference the same shape. */
interface MockRoom {
  connect: Mock
  disconnect: Mock
  startAudio: Mock
  switchActiveDevice: Mock
  localParticipant: {
    setMicrophoneEnabled: Mock
    getTrackPublication: Mock
    audioTrackPublications: Map<string, unknown>
  }
  remoteParticipants: Map<
    string,
    { identity: string; setVolume: Mock; trackPublications: Map<string, unknown> }
  >
  canPlaybackAudio: boolean
  on: Mock
  off: Mock
  removeAllListeners: Mock
  __emit: (event: string, ...args: unknown[]) => void
}

function createMockRoom(): MockRoom {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()

  const room: MockRoom = {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    startAudio: vi.fn().mockResolvedValue(undefined),
    switchActiveDevice: vi.fn().mockResolvedValue(undefined),
    localParticipant: {
      setMicrophoneEnabled: vi.fn().mockResolvedValue(undefined),
      getTrackPublication: vi.fn().mockReturnValue(undefined),
      audioTrackPublications: new Map(),
    },
    remoteParticipants: new Map(),
    canPlaybackAudio: true,

    on: vi.fn(function mockOn(
      this: MockRoom,
      event: string,
      handler: (...args: unknown[]) => void,
    ) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event)?.push(handler)
      return room
    }),

    off: vi.fn(function mockOff(event: string, handler: (...args: unknown[]) => void) {
      const handlers = listeners.get(event)
      if (handlers) {
        const idx = handlers.indexOf(handler)
        if (idx !== -1) handlers.splice(idx, 1)
      }
      return room
    }),

    removeAllListeners: vi.fn(function mockRemoveAll(this: MockRoom, event: string) {
      listeners.delete(event)
      return room
    }),

    __emit(event: string, ...args: unknown[]) {
      for (const handler of listeners.get(event) ?? []) {
        handler(...args)
      }
    },
  }

  return room
}

// WHY: vi.mock hoists above imports. We use a function constructor so
// `new Room(...)` inside the store works correctly.
vi.mock('livekit-client', () => {
  // WHY: Duplicate createMockRoom inside the factory because vi.mock hoisting
  // means the top-level function is not yet available at factory execution time.
  function factoryCreateMockRoom(): Record<string, unknown> {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>()

    const room: Record<string, unknown> = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      startAudio: vi.fn().mockResolvedValue(undefined),
      switchActiveDevice: vi.fn().mockResolvedValue(undefined),
      localParticipant: {
        setMicrophoneEnabled: vi.fn().mockResolvedValue(undefined),
        getTrackPublication: vi.fn().mockReturnValue(undefined),
        audioTrackPublications: new Map(),
      },
      remoteParticipants: new Map(),
      canPlaybackAudio: true,

      on: vi.fn(function mockOn(event: string, handler: (...args: unknown[]) => void) {
        if (!listeners.has(event)) listeners.set(event, [])
        listeners.get(event)?.push(handler)
        return room
      }),

      off: vi.fn(function mockOff(event: string, handler: (...args: unknown[]) => void) {
        const handlers = listeners.get(event)
        if (handlers) {
          const idx = handlers.indexOf(handler)
          if (idx !== -1) handlers.splice(idx, 1)
        }
        return room
      }),

      removeAllListeners: vi.fn(function mockRemoveAll(event: string) {
        listeners.delete(event)
        return room
      }),

      __emit(event: string, ...args: unknown[]) {
        for (const handler of listeners.get(event) ?? []) {
          handler(...args)
        }
      },
    }

    return room
  }

  // WHY: Use a real function (not arrow) so `new Room()` works.
  function MockRoomConstructor() {
    const instance = factoryCreateMockRoom()
    ;(globalThis as Record<string, unknown>).__latestMockRoom = instance
    return instance
  }

  return {
    Room: MockRoomConstructor,
    RoomEvent: {
      Disconnected: 'disconnected',
      Reconnecting: 'reconnecting',
      Reconnected: 'reconnected',
      ActiveSpeakersChanged: 'activeSpeakersChanged',
      MediaDevicesChanged: 'mediaDevicesChanged',
      AudioPlaybackStatusChanged: 'audioPlaybackStatusChanged',
      TrackSubscribed: 'trackSubscribed',
      TrackUnsubscribed: 'trackUnsubscribed',
      LocalTrackPublished: 'localTrackPublished',
      LocalTrackUnpublished: 'localTrackUnpublished',
    },
    Track: {
      Kind: { Audio: 'audio', Video: 'video' },
      Source: { Microphone: 'microphone' },
    },
    LocalAudioTrack: class LocalAudioTrack {},
  }
})

// WHY: Mock the KRISP dynamic import so tests don't load real WASM.
vi.mock('@livekit/krisp-noise-filter', () => ({
  KrispNoiseFilter: vi.fn().mockReturnValue({
    setEnabled: vi.fn().mockResolvedValue(undefined),
  }),
  isKrispNoiseFilterSupported: vi.fn().mockReturnValue(true),
}))

// ---------------------------------------------------------------------------
// Import the store AFTER mocks are set up
// ---------------------------------------------------------------------------

const { useVoiceConnectionStore } = await import('@/features/voice/stores/voice-connection-store')

const initialState = useVoiceConnectionStore.getState()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOKEN = 'test-token'
const URL = 'wss://test.livekit.cloud'
const CHANNEL_ID = 'channel-abc'
const SERVER_ID = 'server-xyz'

/** Connect the store and return the mock Room instance created during connect(). */
async function connectStore(): Promise<MockRoom> {
  await useVoiceConnectionStore.getState().connect(CHANNEL_ID, SERVER_ID, TOKEN, URL)
  return (globalThis as Record<string, unknown>).__latestMockRoom as unknown as MockRoom
}

/** Add a fake remote participant to the mock room. */
function addRemoteParticipant(room: MockRoom, identity: string) {
  room.remoteParticipants.set(identity, {
    identity,
    setVolume: vi.fn(),
    trackPublications: new Map(),
  })
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers()
  useVoiceConnectionStore.setState(initialState, true)
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useVoiceConnectionStore', () => {
  // -------------------------------------------------------------------------
  // Initial state
  // -------------------------------------------------------------------------
  describe('initial state', () => {
    it('has status idle', () => {
      expect(useVoiceConnectionStore.getState().status).toBe('idle')
    })

    it('has no channelId or serverId', () => {
      expect(useVoiceConnectionStore.getState().currentChannelId).toBeNull()
      expect(useVoiceConnectionStore.getState().currentServerId).toBeNull()
    })

    it('has no room', () => {
      expect(useVoiceConnectionStore.getState().room).toBeNull()
    })

    it('is not muted', () => {
      expect(useVoiceConnectionStore.getState().isMuted).toBe(false)
    })

    it('is not deafened', () => {
      expect(useVoiceConnectionStore.getState().isDeafened).toBe(false)
    })

    it('has KRISP enabled by default', () => {
      expect(useVoiceConnectionStore.getState().isKrispEnabled).toBe(true)
    })

    it('has no error', () => {
      expect(useVoiceConnectionStore.getState().error).toBeNull()
    })

    it('has empty activeSpeakers set', () => {
      expect(useVoiceConnectionStore.getState().activeSpeakers).toBeInstanceOf(Set)
      expect(useVoiceConnectionStore.getState().activeSpeakers.size).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // connect()
  // -------------------------------------------------------------------------
  describe('connect', () => {
    it('transitions idle -> connecting -> connected on success', async () => {
      const statusHistory: string[] = []
      const unsub = useVoiceConnectionStore.subscribe((state) => {
        statusHistory.push(state.status)
      })

      await connectStore()

      unsub()
      expect(statusHistory).toContain('connecting')
      expect(useVoiceConnectionStore.getState().status).toBe('connected')
    })

    it('sets channelId, serverId, and room on success', async () => {
      const room = await connectStore()

      const state = useVoiceConnectionStore.getState()
      expect(state.currentChannelId).toBe(CHANNEL_ID)
      expect(state.currentServerId).toBe(SERVER_ID)
      expect(state.room).toBe(room)
    })

    it('calls room.connect with url and token', async () => {
      const room = await connectStore()

      expect(room.connect).toHaveBeenCalledWith(URL, TOKEN)
    })

    it('enables microphone after connecting', async () => {
      const room = await connectStore()

      expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true)
    })

    it('transitions to failed on room.connect() rejection', async () => {
      const livekitModule = await import('livekit-client')
      const original = livekitModule.Room
      const failRoom = createMockRoom()
      failRoom.connect = vi.fn().mockRejectedValue(new Error('connection refused'))

      // @ts-expect-error — overriding module export for test
      livekitModule.Room = function FailingRoom() {
        ;(globalThis as Record<string, unknown>).__latestMockRoom = failRoom
        return failRoom
      }

      await useVoiceConnectionStore.getState().connect(CHANNEL_ID, SERVER_ID, TOKEN, URL)

      const state = useVoiceConnectionStore.getState()
      expect(state.status).toBe('failed')
      expect(state.error).toBe('connection refused')
      expect(state.room).toBeNull()

      livekitModule.Room = original
    })

    it('sets isMuted true when mic enablement fails', async () => {
      const livekitModule = await import('livekit-client')
      const original = livekitModule.Room

      const micFailRoom = createMockRoom()
      micFailRoom.localParticipant.setMicrophoneEnabled = vi
        .fn()
        .mockRejectedValue(new Error('mic denied'))

      // @ts-expect-error — overriding module export for test
      livekitModule.Room = function MicFailRoom() {
        ;(globalThis as Record<string, unknown>).__latestMockRoom = micFailRoom
        return micFailRoom
      }

      await useVoiceConnectionStore.getState().connect(CHANNEL_ID, SERVER_ID, TOKEN, URL)

      expect(useVoiceConnectionStore.getState().isMuted).toBe(true)
      expect(useVoiceConnectionStore.getState().status).toBe('connected')

      livekitModule.Room = original
    })

    it('disconnects existing room before connecting to a new one', async () => {
      const firstRoom = await connectStore()

      await useVoiceConnectionStore.getState().connect('channel-2', 'server-2', TOKEN, URL)

      expect(firstRoom.disconnect).toHaveBeenCalled()
    })

    it('clears error on new connect attempt', async () => {
      useVoiceConnectionStore.setState({ status: 'failed', error: 'previous error' })

      await connectStore()

      expect(useVoiceConnectionStore.getState().error).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // disconnect()
  // -------------------------------------------------------------------------
  describe('disconnect', () => {
    it('calls room.disconnect()', async () => {
      const room = await connectStore()

      await useVoiceConnectionStore.getState().disconnect()

      expect(room.disconnect).toHaveBeenCalled()
    })

    it('resets state to idle with null fields', async () => {
      await connectStore()

      await useVoiceConnectionStore.getState().disconnect()

      const state = useVoiceConnectionStore.getState()
      expect(state.status).toBe('idle')
      expect(state.room).toBeNull()
      expect(state.currentChannelId).toBeNull()
      expect(state.currentServerId).toBeNull()
      expect(state.error).toBeNull()
      expect(state.isMuted).toBe(false)
      expect(state.isDeafened).toBe(false)
      expect(state.activeSpeakers.size).toBe(0)
    })

    it('handles disconnect when no room exists (noop)', async () => {
      await useVoiceConnectionStore.getState().disconnect()

      expect(useVoiceConnectionStore.getState().status).toBe('idle')
    })

    it('still resets state even if room.disconnect() throws', async () => {
      const room = await connectStore()
      room.disconnect = vi.fn().mockRejectedValue(new Error('network error'))

      await useVoiceConnectionStore.getState().disconnect()

      expect(useVoiceConnectionStore.getState().status).toBe('idle')
      expect(useVoiceConnectionStore.getState().room).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // toggleMute()
  // -------------------------------------------------------------------------
  describe('toggleMute', () => {
    it('flips isMuted from false to true', async () => {
      const room = await connectStore()
      expect(useVoiceConnectionStore.getState().isMuted).toBe(false)

      useVoiceConnectionStore.getState().toggleMute()

      expect(useVoiceConnectionStore.getState().isMuted).toBe(true)
      // setMicrophoneEnabled(false) = mute the mic
      expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(false)
    })

    it('flips isMuted from true to false', async () => {
      const room = await connectStore()
      useVoiceConnectionStore.getState().toggleMute() // mute
      vi.clearAllMocks()

      useVoiceConnectionStore.getState().toggleMute() // unmute

      expect(useVoiceConnectionStore.getState().isMuted).toBe(false)
      expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(true)
    })

    it('rolls back isMuted on SDK failure', async () => {
      const room = await connectStore()
      room.localParticipant.setMicrophoneEnabled = vi.fn().mockRejectedValue(new Error('mic error'))

      useVoiceConnectionStore.getState().toggleMute()

      // Optimistic: isMuted flipped to true immediately
      expect(useVoiceConnectionStore.getState().isMuted).toBe(true)

      // After the promise rejects, isMuted should roll back
      await vi.waitFor(() => {
        expect(useVoiceConnectionStore.getState().isMuted).toBe(false)
      })
    })

    it('is a no-op when room is null', () => {
      useVoiceConnectionStore.getState().toggleMute()

      expect(useVoiceConnectionStore.getState().isMuted).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // toggleDeafen()
  // -------------------------------------------------------------------------
  describe('toggleDeafen', () => {
    it('sets isDeafened to true, mutes all remote participants, and disables mic', async () => {
      const room = await connectStore()
      addRemoteParticipant(room, 'user-1')
      addRemoteParticipant(room, 'user-2')

      useVoiceConnectionStore.getState().toggleDeafen()

      expect(useVoiceConnectionStore.getState().isDeafened).toBe(true)
      expect(useVoiceConnectionStore.getState().isMuted).toBe(true)
      for (const p of room.remoteParticipants.values()) {
        expect(p.setVolume).toHaveBeenCalledWith(0)
      }
      expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(false)
    })

    it('undeafens, restores volume to 1, and re-enables mic', async () => {
      const room = await connectStore()
      addRemoteParticipant(room, 'user-1')

      useVoiceConnectionStore.getState().toggleDeafen() // deafen
      vi.clearAllMocks()
      useVoiceConnectionStore.getState().toggleDeafen() // undeafen

      expect(useVoiceConnectionStore.getState().isDeafened).toBe(false)
      expect(useVoiceConnectionStore.getState().isMuted).toBe(false)
      for (const p of room.remoteParticipants.values()) {
        expect(p.setVolume).toHaveBeenCalledWith(1)
      }
      expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true)
    })

    it('rolls back if any participant setVolume fails and does not toggle mic', async () => {
      const room = await connectStore()
      addRemoteParticipant(room, 'user-ok')
      addRemoteParticipant(room, 'user-fail')

      const failParticipant = room.remoteParticipants.get('user-fail')
      if (!failParticipant) throw new Error('test setup: user-fail not found')
      failParticipant.setVolume = vi.fn().mockImplementation(() => {
        throw new Error('volume error')
      })

      // WHY: Clear mocks from connect() so we can assert setMicrophoneEnabled
      // was NOT called by toggleDeafen (it was called once during connect).
      vi.clearAllMocks()
      failParticipant.setVolume = vi.fn().mockImplementation(() => {
        throw new Error('volume error')
      })

      useVoiceConnectionStore.getState().toggleDeafen()

      // Should NOT transition to deafened because of the failure
      expect(useVoiceConnectionStore.getState().isDeafened).toBe(false)
      expect(useVoiceConnectionStore.getState().isMuted).toBe(false)
      // Mic should not be toggled when volume rollback happens
      expect(room.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled()
    })

    it('rolls back isDeafened and isMuted on setMicrophoneEnabled SDK failure', async () => {
      const room = await connectStore()
      addRemoteParticipant(room, 'user-1')
      room.localParticipant.setMicrophoneEnabled = vi.fn().mockRejectedValue(new Error('mic error'))

      useVoiceConnectionStore.getState().toggleDeafen()

      // Optimistic: both flipped immediately
      expect(useVoiceConnectionStore.getState().isDeafened).toBe(true)
      expect(useVoiceConnectionStore.getState().isMuted).toBe(true)

      // After the promise rejects, both should roll back
      await vi.waitFor(() => {
        expect(useVoiceConnectionStore.getState().isDeafened).toBe(false)
        expect(useVoiceConnectionStore.getState().isMuted).toBe(false)
      })
    })

    it('is a no-op when room is null', () => {
      useVoiceConnectionStore.getState().toggleDeafen()

      expect(useVoiceConnectionStore.getState().isDeafened).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // toggleKrisp()
  // -------------------------------------------------------------------------
  describe('toggleKrisp', () => {
    it('sets isKrispEnabled to false when currently enabled', async () => {
      await connectStore()
      expect(useVoiceConnectionStore.getState().isKrispEnabled).toBe(true)

      useVoiceConnectionStore.getState().toggleKrisp()

      expect(useVoiceConnectionStore.getState().isKrispEnabled).toBe(false)
    })

    it('sets isKrispEnabled to true when currently disabled', async () => {
      await connectStore()
      useVoiceConnectionStore.setState({ isKrispEnabled: false })

      useVoiceConnectionStore.getState().toggleKrisp()

      expect(useVoiceConnectionStore.getState().isKrispEnabled).toBe(true)
    })

    it('is a no-op when room is null', () => {
      useVoiceConnectionStore.getState().toggleKrisp()

      // State unchanged (still default true)
      expect(useVoiceConnectionStore.getState().isKrispEnabled).toBe(true)
    })

    it('rolls back isKrispEnabled on toggle failure', async () => {
      const room = await connectStore()
      // WHY: Start with KRISP disabled so toggleKrisp() sets nextEnabled=true,
      // entering the "re-attach" branch that calls attachKrispProcessor → KrispNoiseFilter().
      useVoiceConnectionStore.setState({ isKrispEnabled: false })

      // WHY: getTrackPublication must return a LocalAudioTrack so the re-attach branch proceeds.
      const { LocalAudioTrack } = await import('livekit-client')
      // @ts-expect-error — mock class constructor takes no args
      const mockTrack = Object.assign(new LocalAudioTrack(), { setProcessor: vi.fn() })
      room.localParticipant.getTrackPublication = vi.fn().mockReturnValue({ track: mockTrack })

      // WHY: Make KrispNoiseFilter throw so attachKrispProcessor rejects,
      // triggering the .catch() rollback in toggleKrisp().
      const { KrispNoiseFilter } = await import('@livekit/krisp-noise-filter')
      vi.mocked(KrispNoiseFilter).mockImplementationOnce(() => {
        throw new Error('wasm crash')
      })

      useVoiceConnectionStore.getState().toggleKrisp()

      // Optimistic: toggled to true immediately
      expect(useVoiceConnectionStore.getState().isKrispEnabled).toBe(true)

      // After the promise rejects, isKrispEnabled should roll back to false
      await vi.waitFor(() => {
        expect(useVoiceConnectionStore.getState().isKrispEnabled).toBe(false)
      })
    })
  })

  // -------------------------------------------------------------------------
  // togglePttMode()
  // -------------------------------------------------------------------------
  describe('togglePttMode', () => {
    it('flips isPttMode from false to true', async () => {
      await connectStore()
      expect(useVoiceConnectionStore.getState().isPttMode).toBe(false)

      useVoiceConnectionStore.getState().togglePttMode()

      expect(useVoiceConnectionStore.getState().isPttMode).toBe(true)
    })

    it('mutes mic when toggled ON', async () => {
      const room = await connectStore()
      vi.clearAllMocks()

      useVoiceConnectionStore.getState().togglePttMode()

      // WHY: PTT ON → mic disabled so user must hold key to speak.
      expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(false)
    })

    it('unmutes mic when toggled OFF', async () => {
      const room = await connectStore()
      useVoiceConnectionStore.setState({ isPttMode: true })
      vi.clearAllMocks()

      useVoiceConnectionStore.getState().togglePttMode()

      expect(useVoiceConnectionStore.getState().isPttMode).toBe(false)
      // WHY: PTT OFF → mic re-enabled for normal voice mode.
      expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true)
    })

    it('rolls back isPttMode on setMicrophoneEnabled failure', async () => {
      const room = await connectStore()
      room.localParticipant.setMicrophoneEnabled = vi.fn().mockRejectedValue(new Error('mic error'))

      useVoiceConnectionStore.getState().togglePttMode()

      // Optimistic: isPttMode flipped to true immediately
      expect(useVoiceConnectionStore.getState().isPttMode).toBe(true)

      // After the promise rejects, isPttMode should roll back
      await vi.waitFor(() => {
        expect(useVoiceConnectionStore.getState().isPttMode).toBe(false)
      })
    })

    it('is a no-op for mic when room is null', () => {
      useVoiceConnectionStore.getState().togglePttMode()

      // State flips (no SDK guard on the state update), but no SDK call.
      expect(useVoiceConnectionStore.getState().isPttMode).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // LocalTrackPublished event (KRISP attachment)
  // -------------------------------------------------------------------------
  describe('LocalTrackPublished event', () => {
    it('attaches KRISP processor when isKrispEnabled is true', async () => {
      const room = await connectStore()
      expect(useVoiceConnectionStore.getState().isKrispEnabled).toBe(true)

      const { KrispNoiseFilter } = await import('@livekit/krisp-noise-filter')
      vi.mocked(KrispNoiseFilter).mockClear()

      const { LocalAudioTrack } = await import('livekit-client')
      // @ts-expect-error — mock class constructor takes no args
      const mockTrack = Object.assign(new LocalAudioTrack(), {
        setProcessor: vi.fn().mockResolvedValue(undefined),
      })
      const mockPublication = {
        source: 'microphone',
        track: mockTrack,
      }

      room.__emit('localTrackPublished', mockPublication)

      await vi.waitFor(() => {
        expect(KrispNoiseFilter).toHaveBeenCalled()
      })
    })

    it('skips KRISP when isKrispEnabled is false', async () => {
      const room = await connectStore()
      useVoiceConnectionStore.setState({ isKrispEnabled: false })

      const { KrispNoiseFilter } = await import('@livekit/krisp-noise-filter')
      vi.mocked(KrispNoiseFilter).mockClear()

      const { LocalAudioTrack } = await import('livekit-client')
      // @ts-expect-error — mock class constructor takes no args
      const mockTrack = Object.assign(new LocalAudioTrack(), {
        setProcessor: vi.fn().mockResolvedValue(undefined),
      })
      const mockPublication = {
        source: 'microphone',
        track: mockTrack,
      }

      room.__emit('localTrackPublished', mockPublication)

      // WHY: Give any async work a chance to settle, then verify KRISP was NOT called.
      await vi.waitFor(() => {
        expect(KrispNoiseFilter).not.toHaveBeenCalled()
      })
    })

    it('rolls back isKrispEnabled on KRISP init failure', async () => {
      const room = await connectStore()
      expect(useVoiceConnectionStore.getState().isKrispEnabled).toBe(true)

      const { KrispNoiseFilter } = await import('@livekit/krisp-noise-filter')
      vi.mocked(KrispNoiseFilter).mockImplementationOnce(() => {
        throw new Error('wasm init failed')
      })

      const { LocalAudioTrack } = await import('livekit-client')
      // @ts-expect-error — mock class constructor takes no args
      const mockTrack = Object.assign(new LocalAudioTrack(), {
        setProcessor: vi.fn().mockResolvedValue(undefined),
      })
      const mockPublication = {
        source: 'microphone',
        track: mockTrack,
      }

      room.__emit('localTrackPublished', mockPublication)

      await vi.waitFor(() => {
        expect(useVoiceConnectionStore.getState().isKrispEnabled).toBe(false)
      })
    })
  })

  // -------------------------------------------------------------------------
  // setPttMicEnabled()
  // -------------------------------------------------------------------------
  describe('setPttMicEnabled', () => {
    it('enables microphone when called with true', async () => {
      const room = await connectStore()
      vi.clearAllMocks()

      useVoiceConnectionStore.getState().setPttMicEnabled(true)

      expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true)
    })

    it('disables microphone when called with false', async () => {
      const room = await connectStore()
      vi.clearAllMocks()

      useVoiceConnectionStore.getState().setPttMicEnabled(false)

      expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(false)
    })

    it('does not change isMuted state', async () => {
      await connectStore()

      useVoiceConnectionStore.getState().setPttMicEnabled(false)
      expect(useVoiceConnectionStore.getState().isMuted).toBe(false)

      useVoiceConnectionStore.getState().setPttMicEnabled(true)
      expect(useVoiceConnectionStore.getState().isMuted).toBe(false)
    })

    it('blocks mic enable when deafened', async () => {
      const room = await connectStore()
      useVoiceConnectionStore.getState().toggleDeafen()
      vi.clearAllMocks()

      useVoiceConnectionStore.getState().setPttMicEnabled(true)

      // Mic should NOT be enabled — deafen is a stronger contract than PTT
      expect(room.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled()
    })

    it('allows mic disable when deafened', async () => {
      const room = await connectStore()
      useVoiceConnectionStore.getState().toggleDeafen()
      vi.clearAllMocks()

      useVoiceConnectionStore.getState().setPttMicEnabled(false)

      // Mic disable is always allowed (PTT key-up should work)
      expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(false)
    })

    it('is a no-op when room is null', () => {
      useVoiceConnectionStore.getState().setPttMicEnabled(true)

      expect(useVoiceConnectionStore.getState().isMuted).toBe(false) // unchanged
    })
  })

  // -------------------------------------------------------------------------
  // reset()
  // -------------------------------------------------------------------------
  describe('reset', () => {
    it('resets all state to initial values', async () => {
      await connectStore()
      useVoiceConnectionStore.setState({ isMuted: true, isDeafened: true })

      useVoiceConnectionStore.getState().reset()

      const state = useVoiceConnectionStore.getState()
      expect(state.status).toBe('idle')
      expect(state.room).toBeNull()
      expect(state.currentChannelId).toBeNull()
      expect(state.currentServerId).toBeNull()
      expect(state.isMuted).toBe(false)
      expect(state.isDeafened).toBe(false)
      expect(state.error).toBeNull()
      expect(state.activeSpeakers.size).toBe(0)
    })

    it('calls room.disconnect()', async () => {
      const room = await connectStore()

      useVoiceConnectionStore.getState().reset()

      expect(room.disconnect).toHaveBeenCalled()
    })

    it('removes room event listeners via room.off()', async () => {
      const room = await connectStore()

      useVoiceConnectionStore.getState().reset()

      // WHY: P2-5 replaced removeAllListeners with per-listener room.off() cleanup.
      // After reset, room.off should have been called for each registered listener.
      expect(room.off).toHaveBeenCalled()
    })

    it('does not throw when room is null', () => {
      expect(() => useVoiceConnectionStore.getState().reset()).not.toThrow()
    })

    it('preserves isKrispEnabled, isPttMode, and pttShortcut across reset', async () => {
      await connectStore()
      useVoiceConnectionStore.setState({
        isKrispEnabled: false,
        isPttMode: true,
        pttShortcut: 'KeyV',
      })

      useVoiceConnectionStore.getState().reset()

      const state = useVoiceConnectionStore.getState()
      expect(state.isKrispEnabled).toBe(false)
      expect(state.isPttMode).toBe(true)
      expect(state.pttShortcut).toBe('KeyV')
      expect(state.status).toBe('idle') // other state DID reset
    })
  })

  // -------------------------------------------------------------------------
  // Room event handlers
  // -------------------------------------------------------------------------
  describe('room events', () => {
    describe('Disconnected event', () => {
      it('transitions to disconnected and clears room/channel', async () => {
        const room = await connectStore()

        room.__emit('disconnected')

        const state = useVoiceConnectionStore.getState()
        expect(state.status).toBe('disconnected')
        expect(state.room).toBeNull()
        expect(state.currentChannelId).toBeNull()
        expect(state.currentServerId).toBeNull()
      })

      it('auto-transitions to idle after delay', async () => {
        const room = await connectStore()

        room.__emit('disconnected')
        expect(useVoiceConnectionStore.getState().status).toBe('disconnected')

        // Advance past the 3-second disconnect-to-idle delay
        vi.advanceTimersByTime(3_000)

        expect(useVoiceConnectionStore.getState().status).toBe('idle')
      })

      it('preserves isKrispEnabled across disconnect-to-idle transition', async () => {
        const room = await connectStore()
        useVoiceConnectionStore.setState({ isKrispEnabled: false })

        room.__emit('disconnected')
        vi.advanceTimersByTime(3_000)

        expect(useVoiceConnectionStore.getState().isKrispEnabled).toBe(false)
      })
    })

    describe('Reconnecting event', () => {
      it('transitions to reconnecting', async () => {
        const room = await connectStore()

        room.__emit('reconnecting')

        expect(useVoiceConnectionStore.getState().status).toBe('reconnecting')
      })
    })

    describe('Reconnected event', () => {
      it('transitions back to connected', async () => {
        const room = await connectStore()
        room.__emit('reconnecting')

        room.__emit('reconnected')

        expect(useVoiceConnectionStore.getState().status).toBe('connected')
      })
    })

    describe('speaking detector wiring', () => {
      it('creates a detector when a remote audio track is subscribed', async () => {
        const { createSpeakingDetector } = await import('../lib/speaking-detector')
        const room = await connectStore()

        const mockElement = document.createElement('audio')
        const mockTrack = {
          kind: 'audio',
          attach: vi.fn().mockReturnValue(mockElement),
          detach: vi.fn().mockReturnValue([]),
          mediaStreamTrack: { kind: 'audio', id: 'remote-track' },
        }
        const mockParticipant = { identity: 'remote-user', setVolume: vi.fn() }

        room.__emit('trackSubscribed', mockTrack, {}, mockParticipant)

        expect(createSpeakingDetector).toHaveBeenCalledWith(
          expect.anything(), // AudioContext
          mockTrack.mediaStreamTrack,
          expect.any(Function),
        )

        // Cleanup
        mockElement.remove()
      })

      it('cleans up detector when a remote audio track is unsubscribed', async () => {
        const room = await connectStore()

        const mockElement = document.createElement('audio')
        const mockTrack = {
          kind: 'audio',
          attach: vi.fn().mockReturnValue(mockElement),
          detach: vi.fn().mockReturnValue([mockElement]),
          mediaStreamTrack: { kind: 'audio', id: 'remote-track' },
        }
        const mockParticipant = { identity: 'remote-user', setVolume: vi.fn() }

        room.__emit('trackSubscribed', mockTrack, {}, mockParticipant)
        mockDetectorCleanup.mockClear()

        room.__emit('trackUnsubscribed', mockTrack, {}, mockParticipant)

        expect(mockDetectorCleanup).toHaveBeenCalled()
      })

      it('updates activeSpeakers when detector fires onChange', async () => {
        const { createSpeakingDetector: mockCreate } = await import('../lib/speaking-detector')
        const room = await connectStore()

        // Capture the onChange callback passed to createSpeakingDetector
        let capturedOnChange: ((speaking: boolean) => void) | undefined
        ;(mockCreate as ReturnType<typeof vi.fn>).mockImplementation(
          (_ctx: unknown, _track: unknown, onChange: (speaking: boolean) => void) => {
            capturedOnChange = onChange
            return vi.fn()
          },
        )

        const mockElement = document.createElement('audio')
        const mockTrack = {
          kind: 'audio',
          attach: vi.fn().mockReturnValue(mockElement),
          detach: vi.fn().mockReturnValue([]),
          mediaStreamTrack: { kind: 'audio', id: 'remote-track' },
        }
        const mockParticipant = { identity: 'alice', setVolume: vi.fn() }

        room.__emit('trackSubscribed', mockTrack, {}, mockParticipant)
        expect(capturedOnChange).toBeDefined()

        // Simulate speaking
        capturedOnChange!(true)
        expect(useVoiceConnectionStore.getState().activeSpeakers.has('alice')).toBe(true)

        // Simulate stop speaking
        capturedOnChange!(false)
        expect(useVoiceConnectionStore.getState().activeSpeakers.has('alice')).toBe(false)

        // Cleanup
        mockElement.remove()
      })
    })

    describe('TrackSubscribed event', () => {
      it('attaches audio track and appends element to document.body', async () => {
        const room = await connectStore()

        const mockElement = document.createElement('audio')
        const mockTrack = {
          kind: 'audio',
          attach: vi.fn().mockReturnValue(mockElement),
          detach: vi.fn().mockReturnValue([]),
          mediaStreamTrack: { kind: 'audio', id: 'test-track' },
        }
        const mockParticipant = { identity: 'remote-user', setVolume: vi.fn() }

        room.__emit('trackSubscribed', mockTrack, {}, mockParticipant)

        expect(mockTrack.attach).toHaveBeenCalled()
        expect(mockElement.id).toBe('voice-audio-remote-user')
        expect(document.body.contains(mockElement)).toBe(true)

        // Cleanup
        mockElement.remove()
      })

      it('mutes newly subscribed track when deafened', async () => {
        const room = await connectStore()
        useVoiceConnectionStore.setState({ isDeafened: true })

        const mockElement = document.createElement('audio')
        const mockTrack = {
          kind: 'audio',
          attach: vi.fn().mockReturnValue(mockElement),
          detach: vi.fn().mockReturnValue([]),
          mediaStreamTrack: { kind: 'audio', id: 'test-track' },
        }
        const mockParticipant = { identity: 'late-joiner', setVolume: vi.fn() }

        room.__emit('trackSubscribed', mockTrack, {}, mockParticipant)

        expect(mockParticipant.setVolume).toHaveBeenCalledWith(0)

        // Cleanup
        mockElement.remove()
      })

      it('removes existing audio element with same id to prevent accumulation', async () => {
        const room = await connectStore()

        // Pre-existing element simulating rapid reconnect
        const existing = document.createElement('audio')
        existing.id = 'voice-audio-user-1'
        document.body.appendChild(existing)

        const newElement = document.createElement('audio')
        const mockTrack = {
          kind: 'audio',
          attach: vi.fn().mockReturnValue(newElement),
          detach: vi.fn().mockReturnValue([]),
          mediaStreamTrack: { kind: 'audio', id: 'test-track' },
        }

        room.__emit('trackSubscribed', mockTrack, {}, { identity: 'user-1', setVolume: vi.fn() })

        expect(document.body.contains(existing)).toBe(false)
        expect(document.body.contains(newElement)).toBe(true)

        // Cleanup
        newElement.remove()
      })
    })

    describe('TrackUnsubscribed event', () => {
      it('detaches and removes audio elements', async () => {
        const room = await connectStore()

        const mockElement = document.createElement('audio')
        document.body.appendChild(mockElement)
        const removeSpy = vi.spyOn(mockElement, 'remove')

        const mockTrack = {
          kind: 'audio',
          detach: vi.fn().mockReturnValue([mockElement]),
          mediaStreamTrack: { kind: 'audio', id: 'test-track' },
        }

        room.__emit('trackUnsubscribed', mockTrack, {}, { identity: 'remote-user' })

        expect(mockTrack.detach).toHaveBeenCalled()
        expect(removeSpy).toHaveBeenCalled()
      })

      it('ignores non-audio tracks', async () => {
        const room = await connectStore()

        const mockTrack = {
          kind: 'video',
          detach: vi.fn().mockReturnValue([]),
        }

        room.__emit('trackUnsubscribed', mockTrack, {}, { identity: 'remote-user' })

        expect(mockTrack.detach).not.toHaveBeenCalled()
      })
    })

    describe('LocalTrackUnpublished event', () => {
      it('detaches the track', async () => {
        const room = await connectStore()

        const mockTrack = { detach: vi.fn() }
        const mockPublication = { track: mockTrack }

        room.__emit('localTrackUnpublished', mockPublication)

        expect(mockTrack.detach).toHaveBeenCalled()
      })
    })
  })

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------
  describe('edge cases', () => {
    it('connect() clears pending disconnect-to-idle timer', async () => {
      const firstRoom = await connectStore()
      firstRoom.__emit('disconnected')
      expect(useVoiceConnectionStore.getState().status).toBe('disconnected')

      // Connect again before the idle timer fires
      await useVoiceConnectionStore.getState().connect('channel-2', 'server-2', TOKEN, URL)

      // Advance past what would have been the idle timer
      vi.advanceTimersByTime(5_000)

      // Should still be connected, not reset to idle
      expect(useVoiceConnectionStore.getState().status).toBe('connected')
    })

    it('disconnect event from a stale room is ignored', async () => {
      const firstRoom = await connectStore()

      // Connect to a new channel (replaces the room)
      await useVoiceConnectionStore.getState().connect('channel-2', 'server-2', TOKEN, URL)

      // Stale room fires disconnected — should be ignored
      firstRoom.__emit('disconnected')

      expect(useVoiceConnectionStore.getState().status).toBe('connected')
      expect(useVoiceConnectionStore.getState().currentChannelId).toBe('channel-2')
    })
  })

  // -------------------------------------------------------------------------
  // Audio device preferences
  // -------------------------------------------------------------------------
  describe('audio device preferences', () => {
    it('has null preferred devices in initial state', () => {
      const state = useVoiceConnectionStore.getState()
      expect(state.preferredAudioInputId).toBeNull()
      expect(state.preferredAudioOutputId).toBeNull()
    })

    it('setPreferredDevice updates preferredAudioInputId', async () => {
      await connectStore()

      useVoiceConnectionStore.getState().setPreferredDevice('audioinput', 'mic-123')

      expect(useVoiceConnectionStore.getState().preferredAudioInputId).toBe('mic-123')
      expect(useVoiceConnectionStore.getState().preferredAudioOutputId).toBeNull()
    })

    it('setPreferredDevice updates preferredAudioOutputId', async () => {
      await connectStore()

      useVoiceConnectionStore.getState().setPreferredDevice('audiooutput', 'speaker-456')

      expect(useVoiceConnectionStore.getState().preferredAudioOutputId).toBe('speaker-456')
      expect(useVoiceConnectionStore.getState().preferredAudioInputId).toBeNull()
    })

    it('connect() calls switchActiveDevice for stored input preference', async () => {
      useVoiceConnectionStore.setState({ preferredAudioInputId: 'mic-123' })

      const room = await connectStore()

      expect(room.switchActiveDevice).toHaveBeenCalledWith('audioinput', 'mic-123')
    })

    it('connect() calls switchActiveDevice for stored output preference', async () => {
      useVoiceConnectionStore.setState({ preferredAudioOutputId: 'speaker-456' })

      const room = await connectStore()

      expect(room.switchActiveDevice).toHaveBeenCalledWith('audiooutput', 'speaker-456')
    })

    it('connect() restores both devices when both preferences are set', async () => {
      useVoiceConnectionStore.setState({
        preferredAudioInputId: 'mic-123',
        preferredAudioOutputId: 'speaker-456',
      })

      const room = await connectStore()

      expect(room.switchActiveDevice).toHaveBeenCalledWith('audioinput', 'mic-123')
      expect(room.switchActiveDevice).toHaveBeenCalledWith('audiooutput', 'speaker-456')
    })

    it('connect() does not call switchActiveDevice when no preferences set', async () => {
      const room = await connectStore()

      expect(room.switchActiveDevice).not.toHaveBeenCalled()
    })

    it('connect() logs warning when preferred device switch fails', async () => {
      const { logger } = await import('@/lib/logger')
      useVoiceConnectionStore.setState({ preferredAudioInputId: 'unplugged-mic' })

      const livekitModule = await import('livekit-client')
      const original = livekitModule.Room
      const failRoom = createMockRoom()
      failRoom.switchActiveDevice = vi.fn().mockRejectedValue(new Error('device not found'))

      // @ts-expect-error — overriding module export for test
      livekitModule.Room = function FailSwitchRoom() {
        ;(globalThis as Record<string, unknown>).__latestMockRoom = failRoom
        return failRoom
      }

      await useVoiceConnectionStore.getState().connect(CHANNEL_ID, SERVER_ID, TOKEN, URL)
      // WHY: Let the fire-and-forget switchActiveDevice rejection propagate
      await vi.advanceTimersByTimeAsync(0)

      expect(logger.warn).toHaveBeenCalledWith(
        'voice_restore_preferred_input_failed',
        expect.objectContaining({ deviceId: 'unplugged-mic' }),
      )

      livekitModule.Room = original
    })

    it('preserves preferences across disconnect()', async () => {
      await connectStore()
      useVoiceConnectionStore.getState().setPreferredDevice('audioinput', 'mic-123')
      useVoiceConnectionStore.getState().setPreferredDevice('audiooutput', 'speaker-456')

      await useVoiceConnectionStore.getState().disconnect()

      const state = useVoiceConnectionStore.getState()
      expect(state.preferredAudioInputId).toBe('mic-123')
      expect(state.preferredAudioOutputId).toBe('speaker-456')
      expect(state.status).toBe('idle')
    })

    it('preserves preferences across reset()', async () => {
      await connectStore()
      useVoiceConnectionStore.getState().setPreferredDevice('audioinput', 'mic-123')
      useVoiceConnectionStore.getState().setPreferredDevice('audiooutput', 'speaker-456')

      useVoiceConnectionStore.getState().reset()

      const state = useVoiceConnectionStore.getState()
      expect(state.preferredAudioInputId).toBe('mic-123')
      expect(state.preferredAudioOutputId).toBe('speaker-456')
      expect(state.status).toBe('idle')
    })

    it('preserves preferences across disconnect-to-idle transition', async () => {
      const room = await connectStore()
      useVoiceConnectionStore.getState().setPreferredDevice('audioinput', 'mic-123')

      room.__emit('disconnected')
      vi.advanceTimersByTime(3_000)

      expect(useVoiceConnectionStore.getState().preferredAudioInputId).toBe('mic-123')
      expect(useVoiceConnectionStore.getState().status).toBe('idle')
    })
  })
})
