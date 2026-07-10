import { renderHook } from '@testing-library/react'
import { act } from 'react'
import { vi } from 'vitest'
import { SSE_EVENT_PREFIX } from '@/hooks/use-server-event'
import type { DmListItem, NotificationSettingsResponse, UserPreferencesResponse } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { createQueryWrapper, createTestQueryClient } from '@/tests/test-utils'
import { useNotificationSound } from './use-notification-sound'

vi.mock('@/lib/api', () => ({
  getPreferences: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

const { getPreferences } = await import('@/lib/api')

const CHANNEL_ID = 'channel-1'
const USER_ID = 'user-me'
const SERVER_ID = 'server-1'

// -- Audio stub ----------------------------------------------------------------
// WHY: jsdom's HTMLAudioElement.play() throws "not implemented". A stub records
// constructed sources + play calls so suppression can be asserted precisely.

class FakeAudio {
  static instances: FakeAudio[] = []
  src: string
  volume = 1
  currentTime = 0
  play = vi.fn().mockResolvedValue(undefined)

  constructor(src: string) {
    this.src = src
    FakeAudio.instances.push(this)
  }
}

function totalPlays(): number {
  return FakeAudio.instances.reduce((sum, audio) => sum + audio.play.mock.calls.length, 0)
}

// -- Helpers -------------------------------------------------------------------

function buildPreferences(
  overrides: Partial<UserPreferencesResponse> = {},
): UserPreferencesResponse {
  return {
    dndEnabled: false,
    hideProfanity: true,
    onboardingCompleted: false,
    updatedAt: '2026-04-02T00:00:00.000Z',
    ...overrides,
  }
}

function buildSoundEvent(overrides: Record<string, unknown> = {}) {
  return {
    senderId: 'user-other',
    serverId: SERVER_ID,
    channelId: CHANNEL_ID,
    message: { messageType: 'default' },
    ...overrides,
  }
}

function fireMessageCreated(payload: unknown) {
  window.dispatchEvent(new CustomEvent(`${SSE_EVENT_PREFIX}message.created`, { detail: payload }))
}

/** Seeds preferences + renders the hook with an inactive channel (sounds eligible). */
function renderSoundHook(options: {
  preferences?: UserPreferencesResponse
  activeChannelId?: string | null
}) {
  const queryClient = createTestQueryClient()
  if (options.preferences !== undefined) {
    queryClient.setQueryData(queryKeys.preferences.me(), options.preferences)
  }

  renderHook(() => useNotificationSound(options.activeChannelId ?? 'other-channel', USER_ID), {
    wrapper: createQueryWrapper(queryClient),
  })

  return queryClient
}

// -- Tests ---------------------------------------------------------------------

describe('useNotificationSound', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    FakeAudio.instances = []
    vi.stubGlobal('Audio', FakeAudio)
    // WHY: The background refetch triggered on mount must never resolve, so the
    // seeded cache value stays authoritative for the whole test.
    vi.mocked(getPreferences).mockReturnValue(new Promise(() => {}) as never)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // -- DND suppression (user-preferences-dnd 6.3) ------------------------------

  it('suppresses the sound when DND is enabled', () => {
    renderSoundHook({ preferences: buildPreferences({ dndEnabled: true }) })

    act(() => {
      fireMessageCreated(buildSoundEvent())
    })

    expect(totalPlays()).toBe(0)
  })

  it('plays the channel sound when DND is disabled', () => {
    renderSoundHook({ preferences: buildPreferences({ dndEnabled: false }) })

    act(() => {
      fireMessageCreated(buildSoundEvent())
    })

    expect(totalPlays()).toBe(1)
    expect(FakeAudio.instances[0]?.src).toBe('/sounds/notification-channel.ogg')
  })

  it('treats a still-loading preferences query as DND off (sound plays)', () => {
    // No seeded cache: usePreferences().data === undefined while loading.
    renderSoundHook({})

    act(() => {
      fireMessageCreated(buildSoundEvent())
    })

    expect(totalPlays()).toBe(1)
  })

  it('restores sounds after DND is toggled back off', async () => {
    const queryClient = renderSoundHook({
      preferences: buildPreferences({ dndEnabled: true }),
    })

    act(() => {
      fireMessageCreated(buildSoundEvent())
    })
    expect(totalPlays()).toBe(0)

    // WHY the setTimeout flush: TanStack Query v5 notifies observers via a
    // setTimeout(0) macrotask — the re-render carrying dndEnabled=false must
    // land before the next event is dispatched.
    await act(async () => {
      queryClient.setQueryData(queryKeys.preferences.me(), buildPreferences({ dndEnabled: false }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    act(() => {
      fireMessageCreated(buildSoundEvent())
    })
    expect(totalPlays()).toBe(1)
  })

  // -- Per-channel notification settings (Tier A A6) ---------------------------

  it('suppresses the sound when channel notification level is "none"', () => {
    const queryClient = renderSoundHook({ preferences: buildPreferences() })
    queryClient.setQueryData<NotificationSettingsResponse>(
      queryKeys.notificationSettings.byChannel(CHANNEL_ID),
      { channelId: CHANNEL_ID, level: 'none' },
    )

    act(() => {
      fireMessageCreated(buildSoundEvent())
    })

    expect(totalPlays()).toBe(0)
  })

  it('plays the sound when channel notification level is "all"', () => {
    const queryClient = renderSoundHook({ preferences: buildPreferences() })
    queryClient.setQueryData<NotificationSettingsResponse>(
      queryKeys.notificationSettings.byChannel(CHANNEL_ID),
      { channelId: CHANNEL_ID, level: 'all' },
    )

    act(() => {
      fireMessageCreated(buildSoundEvent())
    })

    expect(totalPlays()).toBe(1)
  })

  // -- Baseline guards ----------------------------------------------------------

  it('suppresses system messages', () => {
    renderSoundHook({ preferences: buildPreferences() })

    act(() => {
      fireMessageCreated(buildSoundEvent({ message: { messageType: 'system' } }))
    })

    expect(totalPlays()).toBe(0)
  })

  it('suppresses own messages', () => {
    renderSoundHook({ preferences: buildPreferences() })

    act(() => {
      fireMessageCreated(buildSoundEvent({ senderId: USER_ID }))
    })

    expect(totalPlays()).toBe(0)
  })

  it('suppresses messages for the actively viewed channel', () => {
    renderSoundHook({ preferences: buildPreferences(), activeChannelId: CHANNEL_ID })

    act(() => {
      fireMessageCreated(buildSoundEvent())
    })

    expect(totalPlays()).toBe(0)
  })

  it('enforces the per-channel cooldown (second rapid message is silent)', () => {
    renderSoundHook({ preferences: buildPreferences() })

    act(() => {
      fireMessageCreated(buildSoundEvent())
      fireMessageCreated(buildSoundEvent())
    })

    expect(totalPlays()).toBe(1)
  })

  it('plays the DM sound when the server is a DM conversation', () => {
    const queryClient = renderSoundHook({ preferences: buildPreferences() })
    queryClient.setQueryData<DmListItem[]>(queryKeys.dms.list(), [
      {
        channelId: CHANNEL_ID,
        serverId: SERVER_ID,
        recipient: { id: 'user-other', username: 'other', avatarUrl: null, displayName: null },
      },
    ])

    act(() => {
      fireMessageCreated(buildSoundEvent())
    })

    expect(totalPlays()).toBe(1)
    expect(FakeAudio.instances[0]?.src).toBe('/sounds/notification-dm.ogg')
  })
})
