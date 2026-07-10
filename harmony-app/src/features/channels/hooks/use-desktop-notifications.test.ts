import { renderHook, waitFor } from '@testing-library/react'
import { act } from 'react'
import { vi } from 'vitest'
import { SSE_EVENT_PREFIX } from '@/hooks/use-server-event'
import type { NotificationSettingsResponse, UserPreferencesResponse } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { createQueryWrapper, createTestQueryClient } from '@/tests/test-utils'
import { useDesktopNotifications } from './use-desktop-notifications'

vi.mock('@/lib/api', () => ({
  getPreferences: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

vi.mock('@/lib/platform', () => ({
  isTauri: vi.fn(() => true),
}))

vi.mock('i18next', () => ({
  default: { t: vi.fn((key: string) => key) },
}))

vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: vi.fn().mockResolvedValue(true),
  requestPermission: vi.fn().mockResolvedValue('granted'),
  sendNotification: vi.fn(),
}))

const { getPreferences } = await import('@/lib/api')
const { isTauri } = await import('@/lib/platform')
const { sendNotification } = await import('@tauri-apps/plugin-notification')

const CHANNEL_ID = 'channel-1'
const USER_ID = 'user-me'

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

function buildNotifEvent(overrides: Record<string, unknown> = {}) {
  return {
    senderId: 'user-other',
    serverId: 'server-1',
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

function renderNotificationHook(options: {
  preferences?: UserPreferencesResponse
  activeChannelId?: string | null
}) {
  const queryClient = createTestQueryClient()
  if (options.preferences !== undefined) {
    queryClient.setQueryData(queryKeys.preferences.me(), options.preferences)
  }

  renderHook(() => useDesktopNotifications(options.activeChannelId ?? 'other-channel', USER_ID), {
    wrapper: createQueryWrapper(queryClient),
  })

  return queryClient
}

/** Flushes the async fireNotification path (permission check + dynamic import). */
async function flushNotificationPipeline() {
  // WHY: Two chained dynamic imports + permission promise — a single macrotask
  // flush is not enough, so drain the microtask queue a few times.
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

// -- Tests ---------------------------------------------------------------------

describe('useDesktopNotifications', () => {
  let hasFocusSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isTauri).mockReturnValue(true)
    // WHY: jsdom reports document.hasFocus() === true, which suppresses every
    // notification. Tests simulate an unfocused (backgrounded) window.
    hasFocusSpy = vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    vi.mocked(getPreferences).mockReturnValue(new Promise(() => {}) as never)
  })

  afterEach(() => {
    hasFocusSpy.mockRestore()
  })

  it('fires a notification for an eligible message', async () => {
    renderNotificationHook({ preferences: buildPreferences() })

    act(() => {
      fireMessageCreated(buildNotifEvent())
    })
    await flushNotificationPipeline()

    await waitFor(() => expect(sendNotification).toHaveBeenCalledOnce())
    expect(sendNotification).toHaveBeenCalledWith({
      title: 'alice',
      body: 'hello world',
    })
  })

  // -- DND suppression (user-preferences-dnd 6.3) ------------------------------

  it('suppresses the notification when DND is enabled', async () => {
    renderNotificationHook({ preferences: buildPreferences({ dndEnabled: true }) })

    act(() => {
      fireMessageCreated(buildNotifEvent())
    })
    await flushNotificationPipeline()

    expect(sendNotification).not.toHaveBeenCalled()
  })

  it('restores notifications after DND is toggled back off', async () => {
    const queryClient = renderNotificationHook({
      preferences: buildPreferences({ dndEnabled: true }),
    })

    act(() => {
      fireMessageCreated(buildNotifEvent())
    })
    await flushNotificationPipeline()
    expect(sendNotification).not.toHaveBeenCalled()

    // WHY the setTimeout flush: TanStack Query v5 notifies observers via a
    // setTimeout(0) macrotask — the re-render carrying dndEnabled=false must
    // land before the next event is dispatched.
    await act(async () => {
      queryClient.setQueryData(queryKeys.preferences.me(), buildPreferences({ dndEnabled: false }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    act(() => {
      fireMessageCreated(buildNotifEvent())
    })
    await flushNotificationPipeline()

    await waitFor(() => expect(sendNotification).toHaveBeenCalledOnce())
  })

  // -- Per-channel notification settings (Tier A A6) ---------------------------

  it('suppresses the notification when channel notification level is "none"', async () => {
    const queryClient = renderNotificationHook({ preferences: buildPreferences() })
    queryClient.setQueryData<NotificationSettingsResponse>(
      queryKeys.notificationSettings.byChannel(CHANNEL_ID),
      { channelId: CHANNEL_ID, level: 'none' },
    )

    act(() => {
      fireMessageCreated(buildNotifEvent())
    })
    await flushNotificationPipeline()

    expect(sendNotification).not.toHaveBeenCalled()
  })

  // -- Baseline guards ----------------------------------------------------------

  it('does nothing outside Tauri (web build)', async () => {
    vi.mocked(isTauri).mockReturnValue(false)
    renderNotificationHook({ preferences: buildPreferences() })

    act(() => {
      fireMessageCreated(buildNotifEvent())
    })
    await flushNotificationPipeline()

    expect(sendNotification).not.toHaveBeenCalled()
  })

  it('suppresses the notification when the window is focused', async () => {
    hasFocusSpy.mockReturnValue(true)
    renderNotificationHook({ preferences: buildPreferences() })

    act(() => {
      fireMessageCreated(buildNotifEvent())
    })
    await flushNotificationPipeline()

    expect(sendNotification).not.toHaveBeenCalled()
  })

  it('suppresses system messages', async () => {
    renderNotificationHook({ preferences: buildPreferences() })

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
    })
    await flushNotificationPipeline()

    expect(sendNotification).not.toHaveBeenCalled()
  })

  it('suppresses own messages', async () => {
    renderNotificationHook({ preferences: buildPreferences() })

    act(() => {
      fireMessageCreated(buildNotifEvent({ senderId: USER_ID }))
    })
    await flushNotificationPipeline()

    expect(sendNotification).not.toHaveBeenCalled()
  })

  it('shows a placeholder body for encrypted messages', async () => {
    renderNotificationHook({ preferences: buildPreferences() })

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

    await waitFor(() => expect(sendNotification).toHaveBeenCalledOnce())
    expect(sendNotification).toHaveBeenCalledWith({
      title: 'alice',
      body: 'common:newEncryptedMessage',
    })
  })
})
