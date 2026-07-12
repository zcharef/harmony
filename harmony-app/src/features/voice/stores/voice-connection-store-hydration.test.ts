/**
 * Hydration tests for voice-connection-store.
 *
 * WHY a separate file: hydration happens at module init (INITIAL_STATE reads
 * localStorage), so each test needs vi.resetModules() + a fresh dynamic import.
 * The main store test file imports the store once at module level — resetting
 * the registry there would desync its shared livekit-client mock references.
 */

import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

/** WHY: Minimal livekit-client mock — only the surface connect() touches.
 * The full room-event behavior is covered by voice-connection-store.test.ts. */
vi.mock('livekit-client', () => {
  function MockRoom() {
    const room = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      startAudio: vi.fn().mockResolvedValue(undefined),
      switchActiveDevice: vi.fn().mockResolvedValue(undefined),
      localParticipant: {
        setMicrophoneEnabled: vi.fn().mockResolvedValue(undefined),
        getTrackPublication: vi.fn().mockReturnValue(undefined),
      },
      remoteParticipants: new Map(),
      canPlaybackAudio: true,
      on: vi.fn(function on(this: unknown) {
        return room
      }),
      off: vi.fn(function off(this: unknown) {
        return room
      }),
    }
    ;(globalThis as Record<string, unknown>).__hydrationMockRoom = room
    return room
  }
  MockRoom.getLocalDevices = vi.fn().mockResolvedValue([])

  return {
    Room: MockRoom,
    RoomEvent: {
      Disconnected: 'disconnected',
      Reconnecting: 'reconnecting',
      Reconnected: 'reconnected',
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
    DisconnectReason: {},
  }
})

async function importFreshStore() {
  const { useVoiceConnectionStore } = await import('./voice-connection-store')
  return useVoiceConnectionStore
}

async function setMockLocalDevices(devices: Array<{ deviceId: string }>) {
  const { Room } = await import('livekit-client')
  ;(Room as unknown as { getLocalDevices: Mock }).getLocalDevices.mockResolvedValue(devices)
}

function getMockRoom() {
  return (globalThis as Record<string, unknown>).__hydrationMockRoom as {
    switchActiveDevice: Mock
  }
}

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
})

describe('voice-connection-store hydration from localStorage', () => {
  it('hydrates persisted device preferences into initial state', async () => {
    localStorage.setItem('voice_preferred_audio_input', 'mic-123')
    localStorage.setItem('voice_preferred_audio_output', 'speaker-456')

    const store = await importFreshStore()

    const state = store.getState()
    expect(state.preferredAudioInputId).toBe('mic-123')
    expect(state.preferredAudioOutputId).toBe('speaker-456')
  })

  it('leaves preferences null when nothing is persisted', async () => {
    const store = await importFreshStore()

    const state = store.getState()
    expect(state.preferredAudioInputId).toBeNull()
    expect(state.preferredAudioOutputId).toBeNull()
  })

  it('hydrates persisted mute/deafen intent into initial state', async () => {
    // WHY (spec B): pre-call mute/deafen is a persistent intent, hydrated at
    // module init exactly like the preferred device IDs.
    localStorage.setItem('voice_preferred_muted', 'true')
    localStorage.setItem('voice_preferred_deafened', 'true')

    const store = await importFreshStore()

    const state = store.getState()
    expect(state.isMuted).toBe(true)
    expect(state.isDeafened).toBe(true)
  })

  it('defaults to unmuted/undeafened when nothing is persisted', async () => {
    const store = await importFreshStore()

    const state = store.getState()
    expect(state.isMuted).toBe(false)
    expect(state.isDeafened).toBe(false)
  })

  it('applies the hydrated mute intent to the room on connect', async () => {
    // WHY (spec B): the full persist → rehydrate → apply loop — a pre-muted
    // user's mic is disabled on join.
    localStorage.setItem('voice_preferred_muted', 'true')

    const store = await importFreshStore()
    await store.getState().connect('channel-1', 'server-1', 'token', 'wss://test')

    expect(store.getState().isMuted).toBe(true)
    const room = (globalThis as Record<string, unknown>).__hydrationMockRoom as {
      localParticipant: { setMicrophoneEnabled: Mock }
    }
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(false)
  })

  it('connect() applies the hydrated preference to the new room', async () => {
    // WHY (spec req 4): pins the full persist → rehydrate → apply loop —
    // the next session must reuse the device picked last time.
    localStorage.setItem('voice_preferred_audio_input', 'mic-123')
    await setMockLocalDevices([{ deviceId: 'default' }, { deviceId: 'mic-123' }])

    const store = await importFreshStore()
    await store.getState().connect('channel-1', 'server-1', 'token', 'wss://test')

    await vi.waitFor(() => {
      expect(getMockRoom().switchActiveDevice).toHaveBeenCalledWith('audioinput', 'mic-123')
    })
  })

  it('falls back with inline notice when the persisted device is gone at connect', async () => {
    // WHY (spec req 4): a device unplugged between sessions must get the same
    // fallback treatment as a mid-call unplug — default device + inline notice,
    // and the stale ID purged from both the store and localStorage.
    localStorage.setItem('voice_preferred_audio_input', 'stale-mic')
    await setMockLocalDevices([{ deviceId: 'default' }])

    const store = await importFreshStore()
    expect(store.getState().preferredAudioInputId).toBe('stale-mic')

    await store.getState().connect('channel-1', 'server-1', 'token', 'wss://test')

    await vi.waitFor(() => {
      expect(store.getState().preferredAudioInputId).toBeNull()
    })
    expect(store.getState().deviceFallbacks).toEqual(['audioinput'])
    expect(localStorage.getItem('voice_preferred_audio_input')).toBeNull()
    // WHY: The system default is already active from mic enablement — no switch.
    expect(getMockRoom().switchActiveDevice).not.toHaveBeenCalled()
  })
})
