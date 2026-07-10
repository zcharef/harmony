import { renderHook, waitFor } from '@testing-library/react'
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

vi.mock('@/lib/platform', () => ({
  isTauri: vi.fn(() => false),
}))

vi.mock('i18next', () => ({
  default: { t: vi.fn((key: string) => key) },
}))

vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: vi.fn().mockResolvedValue(true),
  requestPermission: vi.fn().mockResolvedValue('granted'),
  sendNotification: vi.fn(),
}))

const { getPreferences, listNotificationSettings } = await import('@/lib/api')
const { logger } = await import('@/lib/logger')
const { isTauri } = await import('@/lib/platform')
const { sendNotification } = await import('@tauri-apps/plugin-notification')
const { useDesktopNotifications } = await import('./use-desktop-notifications')

const CHANNEL_ID = 'channel-1'
const SERVER_ID = 'server-1'
const DM_SERVER = 'dm-server-1'
const DM_CHANNEL = 'dm-channel-1'
const USER_ID = 'user-me'

// -- Notification constructor stub ---------------------------------------------

interface StubInstance {
  title: string
  options: Record<string, unknown>
}

let constructed: StubInstance[] = []

function installNotificationStub(permission: string) {
  constructed = []

  class NotificationStub {
    static permission = permission
    close = vi.fn()
    onclick: (() => void) | null = null

    constructor(title: string, options: Record<string, unknown>) {
      constructed.push({ title, options })
    }
  }

  vi.stubGlobal('Notification', NotificationStub)
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

function buildNotifEvent(overrides: Record<string, unknown> = {}) {
  return {
    senderId: 'user-other',
    serverId: SERVER_ID,
    channelId: CHANNEL_ID,
    message: {
      authorUsername: 'alice',
      content: 'hello world',
      messageType: 'default',
      encrypted: false,
    },
    ...overrides,
  }
}

function fireMessageCreated(payload: unknown) {
  window.dispatchEvent(new CustomEvent(`${SSE_EVENT_PREFIX}message.created`, { detail: payload }))
}

function renderNotificationHook(
  options: {
    preferences?: UserPreferencesResponse
    overrides?: ListNotificationSettingsResponse
    activeChannelId?: string | null
    seedDms?: boolean
  } = {},
) {
  const queryClient = createTestQueryClient()
  queryClient.setQueryData(queryKeys.preferences.me(), options.preferences ?? buildPreferences())
  if (options.overrides !== undefined) {
    queryClient.setQueryData(queryKeys.notificationSettings.mine(), options.overrides)
  }
  // WHY seed DMs by default: an unseeded DMs cache classifies every server as
  // 'unknown' — seeding pins the deterministic 'channel'/'dm' classes.
  if (options.seedDms !== false) {
    queryClient.setQueryData(queryKeys.dms.list(), buildDmList())
  }

  renderHook(() => useDesktopNotifications(options.activeChannelId ?? 'other-channel', USER_ID), {
    wrapper: createQueryWrapper(queryClient),
  })

  return queryClient
}

/** Flushes the async pipeline (cross-tab focus check + adapter dispatch). */
async function flushNotificationPipeline() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

// -- Tests ---------------------------------------------------------------------

describe('useDesktopNotifications (web)', () => {
  let hasFocusSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isTauri).mockReturnValue(false)
    installNotificationStub('granted')
    // WHY: jsdom reports document.hasFocus() === true, which suppresses every
    // notification. Tests simulate an unfocused (backgrounded) window.
    hasFocusSpy = vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    vi.mocked(getPreferences).mockReturnValue(new Promise(() => {}) as never)
    vi.mocked(listNotificationSettings).mockReturnValue(new Promise(() => {}) as never)
  })

  afterEach(() => {
    hasFocusSpy.mockRestore()
    vi.unstubAllGlobals()
  })

  it('constructs a web Notification with tag and author title for an eligible message', async () => {
    renderNotificationHook()

    act(() => {
      fireMessageCreated(buildNotifEvent())
    })
    await flushNotificationPipeline()

    await waitFor(() => expect(constructed).toHaveLength(1))
    expect(constructed[0]?.title).toBe('alice')
    expect(constructed[0]?.options).toMatchObject({
      body: 'hello world',
      tag: `channel:${CHANNEL_ID}`,
      silent: true,
    })
  })

  it('prefers the author display name as title (identity render chain)', async () => {
    renderNotificationHook()

    act(() => {
      fireMessageCreated(
        buildNotifEvent({
          message: {
            authorUsername: 'alice',
            authorDisplayName: 'Alice Doe',
            content: 'hi',
            messageType: 'default',
            encrypted: false,
          },
        }),
      )
    })
    await flushNotificationPipeline()

    await waitFor(() => expect(constructed).toHaveLength(1))
    expect(constructed[0]?.title).toBe('Alice Doe')
  })

  it('notifies for the ACTIVE channel when the window is blurred (gate 5 parity fix)', async () => {
    renderNotificationHook({ activeChannelId: CHANNEL_ID })

    act(() => {
      fireMessageCreated(buildNotifEvent())
    })
    await flushNotificationPipeline()

    await waitFor(() => expect(constructed).toHaveLength(1))
  })

  it('suppresses when the window is focused', async () => {
    hasFocusSpy.mockReturnValue(true)
    renderNotificationHook()

    act(() => {
      fireMessageCreated(buildNotifEvent())
    })
    await flushNotificationPipeline()

    expect(constructed).toHaveLength(0)
  })

  it('suppresses when DND is enabled', async () => {
    renderNotificationHook({ preferences: buildPreferences({ dndEnabled: true }) })

    act(() => {
      fireMessageCreated(buildNotifEvent())
    })
    await flushNotificationPipeline()

    expect(constructed).toHaveLength(0)
  })

  it('REACTIVITY: a settings toggle in the cache flips behavior with zero refetch', async () => {
    const queryClient = renderNotificationHook({
      preferences: buildPreferences({ notificationsEnabled: false }),
    })

    act(() => {
      fireMessageCreated(buildNotifEvent())
    })
    await flushNotificationPipeline()
    expect(constructed).toHaveLength(0)

    // Simulate the settings switch (optimistic cache write, no refetch).
    // WHY the setTimeout flush: TanStack Query notifies observers via a
    // macrotask — the re-render must land before the next event.
    await act(async () => {
      queryClient.setQueryData(
        queryKeys.preferences.me(),
        buildPreferences({ notificationsEnabled: true }),
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    act(() => {
      fireMessageCreated(buildNotifEvent())
    })
    await flushNotificationPipeline()

    await waitFor(() => expect(constructed).toHaveLength(1))
  })

  it("suppresses a channel muted to 'none' via the bulk map — without ever visiting it", async () => {
    renderNotificationHook({
      overrides: buildOverrides([{ channelId: CHANNEL_ID, level: 'none' }]),
    })

    act(() => {
      fireMessageCreated(buildNotifEvent())
    })
    await flushNotificationPipeline()

    expect(constructed).toHaveLength(0)
  })

  it("level 'mentions': suppresses plain messages but notifies actual mentions", async () => {
    renderNotificationHook({
      overrides: buildOverrides([{ channelId: CHANNEL_ID, level: 'mentions' }]),
    })

    act(() => {
      fireMessageCreated(buildNotifEvent())
    })
    await flushNotificationPipeline()
    expect(constructed).toHaveLength(0)

    act(() => {
      fireMessageCreated(
        buildNotifEvent({
          message: {
            authorUsername: 'alice',
            content: 'hey @me',
            messageType: 'default',
            encrypted: false,
            mentions: [{ userId: USER_ID }],
          },
        }),
      )
    })
    await flushNotificationPipeline()

    await waitFor(() => expect(constructed).toHaveLength(1))
  })

  it('notifyDms=false gates DM notifications independently of server messages', async () => {
    renderNotificationHook({ preferences: buildPreferences({ notifyDms: false }) })

    act(() => {
      fireMessageCreated(buildNotifEvent({ serverId: DM_SERVER, channelId: DM_CHANNEL }))
    })
    await flushNotificationPipeline()
    expect(constructed).toHaveLength(0)

    act(() => {
      fireMessageCreated(buildNotifEvent())
    })
    await flushNotificationPipeline()

    await waitFor(() => expect(constructed).toHaveLength(1))
  })

  it('suppresses system and own messages', async () => {
    renderNotificationHook()

    act(() => {
      fireMessageCreated(
        buildNotifEvent({
          message: {
            authorUsername: 'system',
            content: 'user joined',
            messageType: 'system',
            encrypted: false,
          },
        }),
      )
      fireMessageCreated(buildNotifEvent({ senderId: USER_ID }))
    })
    await flushNotificationPipeline()

    expect(constructed).toHaveLength(0)
  })

  it('shows a placeholder body for encrypted messages (never ciphertext)', async () => {
    renderNotificationHook()

    act(() => {
      fireMessageCreated(
        buildNotifEvent({
          message: {
            authorUsername: 'alice',
            content: 'ciphertext',
            messageType: 'default',
            encrypted: true,
          },
        }),
      )
    })
    await flushNotificationPipeline()

    await waitFor(() => expect(constructed).toHaveLength(1))
    expect(constructed[0]?.options.body).toBe('common:newEncryptedMessage')
  })

  it('denied permission: no construction, ONE info log per session', async () => {
    installNotificationStub('denied')
    renderNotificationHook()

    act(() => {
      fireMessageCreated(buildNotifEvent())
    })
    await flushNotificationPipeline()
    act(() => {
      fireMessageCreated(buildNotifEvent({ channelId: 'channel-2' }))
    })
    await flushNotificationPipeline()

    expect(constructed).toHaveLength(0)
    const unavailableCalls = vi
      .mocked(logger.info)
      .mock.calls.filter(([key]) => key === 'notifications_unavailable')
    expect(unavailableCalls).toHaveLength(1)
    expect(unavailableCalls[0]?.[1]).toEqual({ state: 'denied' })
  })

  it('applies the per-channel cooldown', async () => {
    renderNotificationHook()

    act(() => {
      fireMessageCreated(buildNotifEvent())
    })
    await flushNotificationPipeline()
    act(() => {
      fireMessageCreated(buildNotifEvent())
    })
    await flushNotificationPipeline()

    await waitFor(() => expect(constructed).toHaveLength(1))
  })
})

describe('useDesktopNotifications (Tauri)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isTauri).mockReturnValue(true)
    installNotificationStub('granted')
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    vi.mocked(getPreferences).mockReturnValue(new Promise(() => {}) as never)
    vi.mocked(listNotificationSettings).mockReturnValue(new Promise(() => {}) as never)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('delegates to the Tauri plugin instead of the web Notification API', async () => {
    renderNotificationHook()

    act(() => {
      fireMessageCreated(buildNotifEvent())
    })
    await flushNotificationPipeline()

    await waitFor(() =>
      expect(sendNotification).toHaveBeenCalledWith({ title: 'alice', body: 'hello world' }),
    )
    expect(constructed).toHaveLength(0)
  })
})
