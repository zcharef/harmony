import { renderHook } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SSE_EVENT_PREFIX } from '@/hooks/use-server-event'
import type {
  DmListItem,
  ListNotificationSettingsResponse,
  NotificationLevel,
  UserPreferencesResponse,
} from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { createQueryWrapper, createTestQueryClient } from '@/tests/test-utils'

vi.mock('@/lib/api', () => ({
  getPreferences: vi.fn(),
  listNotificationSettings: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

const { getPreferences, listNotificationSettings } = await import('@/lib/api')
const { useNotificationSound } = await import('./use-notification-sound')

const CHANNEL_ID = 'channel-1'
const SERVER_ID = 'server-1'
const DM_SERVER = 'dm-server-1'
const DM_CHANNEL = 'dm-channel-1'
const USER_ID = 'user-me'

// -- Audio stub ----------------------------------------------------------------

const playMock = vi.fn().mockResolvedValue(undefined)
let audioSources: string[] = []

class AudioStub {
  src: string
  volume = 1
  currentTime = 0
  play = playMock

  constructor(src: string) {
    this.src = src
    audioSources.push(src)
  }
}

// -- Helpers -------------------------------------------------------------------

function buildPreferences(
  overrides: Partial<UserPreferencesResponse> = {},
): UserPreferencesResponse {
  return {
    dndEnabled: false,
    hideProfanity: true,
    onboardingCompleted: false,
    notificationsEnabled: true,
    notifyMessages: true,
    notifyDms: true,
    notifyMentions: true,
    notificationSoundsEnabled: true,
    updatedAt: '2026-04-02T00:00:00.000Z',
    ...overrides,
  }
}

function buildOverrides(
  entries: Array<{ channelId: string; level: NotificationLevel }>,
): ListNotificationSettingsResponse {
  return { items: entries, total: entries.length, nextCursor: null }
}

function buildDmList(): DmListItem[] {
  return [
    {
      serverId: DM_SERVER,
      channelId: DM_CHANNEL,
      recipient: { id: 'user-other', username: 'alice' },
    },
  ]
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

function renderSoundHook(
  options: {
    preferences?: UserPreferencesResponse
    overrides?: ListNotificationSettingsResponse
    activeChannelId?: string | null
  } = {},
) {
  const queryClient = createTestQueryClient()
  queryClient.setQueryData(queryKeys.preferences.me(), options.preferences ?? buildPreferences())
  if (options.overrides !== undefined) {
    queryClient.setQueryData(queryKeys.notificationSettings.mine(), options.overrides)
  }
  queryClient.setQueryData(queryKeys.dms.list(), buildDmList())

  renderHook(() => useNotificationSound(options.activeChannelId ?? 'other-channel', USER_ID), {
    wrapper: createQueryWrapper(queryClient),
  })

  return queryClient
}

// -- Tests ---------------------------------------------------------------------

describe('useNotificationSound', () => {
  let hasFocusSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    audioSources = []
    vi.stubGlobal('Audio', AudioStub)
    hasFocusSpy = vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    vi.mocked(getPreferences).mockReturnValue(new Promise(() => {}) as never)
    vi.mocked(listNotificationSettings).mockReturnValue(new Promise(() => {}) as never)
  })

  afterEach(() => {
    hasFocusSpy.mockRestore()
    vi.unstubAllGlobals()
  })

  it('plays the channel sound for an eligible server message', () => {
    renderSoundHook()

    act(() => {
      fireMessageCreated(buildSoundEvent())
    })

    expect(playMock).toHaveBeenCalledOnce()
    expect(audioSources).toEqual(['/sounds/notification-channel.ogg'])
  })

  it('plays the DM sound for direct messages', () => {
    renderSoundHook()

    act(() => {
      fireMessageCreated(buildSoundEvent({ serverId: DM_SERVER, channelId: DM_CHANNEL }))
    })

    expect(playMock).toHaveBeenCalledOnce()
    expect(audioSources).toEqual(['/sounds/notification-dm.ogg'])
  })

  it('gate 5: suppresses only when the channel is active AND the window focused', () => {
    renderSoundHook({ activeChannelId: CHANNEL_ID })

    // Active + blurred → plays (Discord parity fix; old code suppressed here).
    act(() => {
      fireMessageCreated(buildSoundEvent())
    })
    expect(playMock).toHaveBeenCalledTimes(1)

    // Active + focused → suppressed.
    hasFocusSpy.mockReturnValue(true)
    act(() => {
      fireMessageCreated(buildSoundEvent({ channelId: CHANNEL_ID }))
    })
    expect(playMock).toHaveBeenCalledTimes(1)
  })

  it('suppresses when DND is enabled', () => {
    renderSoundHook({ preferences: buildPreferences({ dndEnabled: true }) })

    act(() => {
      fireMessageCreated(buildSoundEvent())
    })

    expect(playMock).not.toHaveBeenCalled()
  })

  it('REACTIVITY: the sounds master switch is honored straight from the cache', async () => {
    const queryClient = renderSoundHook({
      preferences: buildPreferences({ notificationSoundsEnabled: false }),
    })

    act(() => {
      fireMessageCreated(buildSoundEvent())
    })
    expect(playMock).not.toHaveBeenCalled()

    await act(async () => {
      queryClient.setQueryData(
        queryKeys.preferences.me(),
        buildPreferences({ notificationSoundsEnabled: true }),
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    act(() => {
      fireMessageCreated(buildSoundEvent())
    })
    expect(playMock).toHaveBeenCalledOnce()
  })

  it("suppresses a channel muted to 'none' via the bulk map", () => {
    renderSoundHook({ overrides: buildOverrides([{ channelId: CHANNEL_ID, level: 'none' }]) })

    act(() => {
      fireMessageCreated(buildSoundEvent())
    })

    expect(playMock).not.toHaveBeenCalled()
  })

  it("level 'mentions': suppresses plain messages, plays for actual mentions", () => {
    renderSoundHook({
      overrides: buildOverrides([{ channelId: CHANNEL_ID, level: 'mentions' }]),
    })

    act(() => {
      fireMessageCreated(buildSoundEvent())
    })
    expect(playMock).not.toHaveBeenCalled()

    act(() => {
      fireMessageCreated(
        buildSoundEvent({
          message: { messageType: 'default', mentions: [{ userId: USER_ID }] },
        }),
      )
    })
    expect(playMock).toHaveBeenCalledOnce()
  })

  it('suppresses system and own messages', () => {
    renderSoundHook()

    act(() => {
      fireMessageCreated(buildSoundEvent({ message: { messageType: 'system' } }))
      fireMessageCreated(buildSoundEvent({ senderId: USER_ID }))
    })

    expect(playMock).not.toHaveBeenCalled()
  })

  it('applies the per-channel cooldown', () => {
    renderSoundHook()

    act(() => {
      fireMessageCreated(buildSoundEvent())
      fireMessageCreated(buildSoundEvent())
    })

    expect(playMock).toHaveBeenCalledOnce()
  })
})
