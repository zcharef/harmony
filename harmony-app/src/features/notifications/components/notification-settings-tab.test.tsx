import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// WHY: Side-effect import initializes the real i18n instance so labels resolve
// to actual translations.
import '@/lib/i18n'
import type { UserPreferencesResponse } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { createQueryWrapper, createTestQueryClient } from '@/tests/test-utils'

configure({ testIdAttribute: 'data-test' })

vi.mock('@/lib/api', () => ({
  getPreferences: vi.fn(),
  updatePreferences: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

vi.mock('@/lib/platform', () => ({
  isTauri: vi.fn(() => false),
}))

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

const { getPreferences, updatePreferences } = await import('@/lib/api')
const { isTauri } = await import('@/lib/platform')
const { NotificationSettingsTab } = await import('./notification-settings-tab')

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

function renderTab(options: { preferences?: UserPreferencesResponse; seedCache?: boolean } = {}) {
  const queryClient = createTestQueryClient()
  if (options.seedCache !== false) {
    queryClient.setQueryData(queryKeys.preferences.me(), options.preferences ?? buildPreferences())
  }

  const Wrapper = createQueryWrapper(queryClient)
  const view = render(
    <Wrapper>
      <NotificationSettingsTab />
    </Wrapper>,
  )
  return { queryClient, view }
}

function stubNotificationPermission(permission: string) {
  vi.stubGlobal('Notification', {
    permission,
    requestPermission: vi.fn().mockResolvedValue('granted'),
  })
}

describe('NotificationSettingsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isTauri).mockReturnValue(false)
    stubNotificationPermission('granted')
    vi.mocked(getPreferences).mockReturnValue(new Promise(() => {}) as never)
    vi.mocked(updatePreferences).mockResolvedValue({} as never)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders every switch from the preferences cache (no local state shadow)', () => {
    renderTab({
      preferences: buildPreferences({ notifyDms: false, notificationSoundsEnabled: false }),
    })

    expect(screen.getByTestId('notification-master-switch')).toBeTruthy()
    const master = screen
      .getByTestId('notification-master-switch')
      .querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(master.checked).toBe(true)

    const dms = screen
      .getByTestId('notification-dms-switch')
      .querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(dms.checked).toBe(false)

    const sounds = screen
      .getByTestId('notification-sounds-switch')
      .querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(sounds.checked).toBe(false)

    // Mentions switch is live (mentions feature shipped).
    expect(screen.getByTestId('notification-mentions-switch')).toBeTruthy()
  })

  it('toggling a switch mutates ONLY the changed field', async () => {
    renderTab()

    const input = screen
      .getByTestId('notification-messages-switch')
      .querySelector('input[type="checkbox"]') as HTMLInputElement
    fireEvent.click(input)

    // WHY waitFor: useMutation invokes mutationFn asynchronously.
    await waitFor(() => expect(updatePreferences).toHaveBeenCalledTimes(1))
    expect(updatePreferences).toHaveBeenCalledWith({
      body: { notifyMessages: false },
      throwOnError: true,
    })
  })

  it('shows the loading skeleton while preferences are pending', () => {
    renderTab({ seedCache: false })
    expect(screen.getByTestId('notification-settings-loading')).toBeTruthy()
  })

  it('shows the error state with a retry button when the read fails', async () => {
    vi.mocked(getPreferences).mockRejectedValueOnce(new Error('read failed'))
    renderTab({ seedCache: false })

    expect(await screen.findByTestId('notification-settings-error')).toBeTruthy()
  })

  it('shows the blocked chip and help when the browser denied permission', () => {
    stubNotificationPermission('denied')
    renderTab()

    expect(screen.getByTestId('notification-permission-denied')).toBeTruthy()
    expect(screen.getByTestId('notification-permission-denied-help')).toBeTruthy()
  })

  it('shows the enable button when permission was never asked', () => {
    stubNotificationPermission('default')
    renderTab()

    expect(screen.getByTestId('notification-permission-enable')).toBeTruthy()
  })

  it('shows the DND hint row only while DND is active', () => {
    renderTab({ preferences: buildPreferences({ dndEnabled: true }) })
    expect(screen.getByTestId('notification-dnd-hint')).toBeTruthy()
  })

  it('hides the DND hint when DND is off', () => {
    renderTab()
    expect(screen.queryByTestId('notification-dnd-hint')).toBeNull()
  })
})
