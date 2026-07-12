import { configure, fireEvent, render, screen } from '@testing-library/react'
import { vi } from 'vitest'
import type { ProfileResponse } from '@/lib/api'
// WHY side-effect import: initializes the real i18n instance so the settings
// namespace keys resolve to text (missing keys would otherwise log).
import '@/lib/i18n'

// WHY: The repo uses data-test (not data-testid).
configure({ testIdAttribute: 'data-test' })

// WHY: HeroUI Tabs measures its cursor with ResizeObserver, absent from jsdom.
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
)

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// WHY: the modal footer's logout calls supabase.auth.signOut; the real client
// pulls env validation that does not belong in a render test. vi.hoisted keeps
// the spy available inside the hoisted vi.mock factory.
const { signOutMock } = vi.hoisted(() => ({
  signOutMock: vi.fn(() => Promise.resolve({ error: null })),
}))
vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { signOut: signOutMock } },
}))

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

function buildProfile(): ProfileResponse {
  return {
    id: 'user-1',
    username: 'zcharef',
    displayName: 'Zayed',
    avatarUrl: null,
    bannerUrl: null,
    bio: null,
    status: 'online',
    customStatus: null,
    isFounding: false,
    avatarModerationStatus: 'approved',
    bannerModerationStatus: 'approved',
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-01T00:00:00Z',
  }
}

/** Idle TanStack-mutation stand-in — the profile tab only reads these flags. */
function mutationStub() {
  return { mutate: vi.fn(), isPending: false, isError: false, error: null }
}

// WHY full mock (no importOriginal): the auth barrel pulls in the Supabase
// client and env validation, neither of which belongs in this render test.
vi.mock('@/features/auth', () => ({
  AvatarUploadError: class AvatarUploadError extends Error {},
  useCurrentProfile: () => ({ data: buildProfile(), isPending: false }),
  useUpdateProfile: () => mutationStub(),
  useUploadAvatar: () => mutationStub(),
  useUploadBanner: () => mutationStub(),
}))

vi.mock('@/features/notifications', () => ({
  NotificationSettingsTab: () => <div data-test="stub-notifications-tab" />,
}))

vi.mock('@/features/admin', () => ({
  AdminTab: () => <div data-test="stub-admin-tab" />,
}))

// WHY mockable: the Desktop tab is Tauri-only — tests flip this per case.
const { isTauriMock } = vi.hoisted(() => ({ isTauriMock: vi.fn(() => false) }))
vi.mock('@/lib/platform', () => ({
  isTauri: () => isTauriMock(),
}))

vi.mock('./stores/settings-ui-store', () => ({
  useSettingsUiStore: (
    selector: (s: {
      showUserSettings: boolean
      userSettingsTab: string
      setUserSettingsTab: () => void
      closeUserSettings: () => void
    }) => unknown,
  ) =>
    selector({
      showUserSettings: true,
      userSettingsTab: 'profile',
      setUserSettingsTab: vi.fn(),
      closeUserSettings: vi.fn(),
    }),
}))

import { UserSettingsModal } from './user-settings-modal'

const writeText = vi.fn(() => Promise.resolve())

beforeEach(() => {
  vi.clearAllMocks()
  // WHY defineProperty: jsdom has no navigator.clipboard — install a stub.
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  })
})

describe('UserSettingsModal username field', () => {
  it('renders the @username read-only with the immutability helper text', () => {
    render(<UserSettingsModal />)

    const input = screen.getByTestId('profile-username-input')
    expect(input).toHaveProperty('value', '@zcharef')
    expect(input).toHaveProperty('readOnly', true)
    expect(screen.getByText("Usernames can't be changed yet.")).toBeTruthy()
  })

  it('copies the @username to the clipboard and confirms inline', async () => {
    render(<UserSettingsModal />)

    const copyButton = screen.getByTestId('profile-username-copy-button')
    expect(copyButton.getAttribute('aria-label')).toBe('Copy username')

    fireEvent.click(copyButton)

    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith('@zcharef')
    // Inline confirmation: the button flips to its "copied" state.
    expect(
      (await screen.findByTestId('profile-username-copy-button')).getAttribute('aria-label'),
    ).toBe('Copied')
  })

  it('keeps the username out of the editable form fields', () => {
    render(<UserSettingsModal />)

    // The display-name input stays editable right next to the read-only handle.
    const displayName = screen.getByTestId('profile-display-name-input')
    expect(displayName).toHaveProperty('readOnly', false)
    expect(displayName).toHaveProperty('value', 'Zayed')
  })
})

describe('UserSettingsModal desktop tab gating', () => {
  it('hides the Desktop tab on the web', () => {
    isTauriMock.mockReturnValue(false)
    render(<UserSettingsModal />)

    expect(screen.queryByTestId('user-settings-tab-desktop')).toBeNull()
  })

  it('shows the Desktop tab inside the Tauri shell', () => {
    isTauriMock.mockReturnValue(true)
    render(<UserSettingsModal />)

    expect(screen.getByTestId('user-settings-tab-desktop')).toBeTruthy()
  })
})

describe('UserSettingsModal admin tab gating', () => {
  it('hides the Admin tab for a non-founder (isPlatformAdmin absent)', () => {
    // The mocked profile above has no isPlatformAdmin flag → the tab is hidden.
    render(<UserSettingsModal />)

    expect(screen.queryByTestId('user-settings-tab-admin')).toBeNull()
  })
})

describe('UserSettingsModal logout', () => {
  it('renders the logout button in red (bottom-left) with a sign-out label', () => {
    render(<UserSettingsModal />)

    const button = screen.getByTestId('user-settings-logout-button')
    expect(button).toBeTruthy()
    expect(button.textContent).toContain('Log out')
    // HeroUI applies the danger color token to the button.
    expect(button.className).toContain('danger')
  })

  it('signs out when pressed', () => {
    render(<UserSettingsModal />)

    fireEvent.click(screen.getByTestId('user-settings-logout-button'))

    expect(signOutMock).toHaveBeenCalledTimes(1)
  })
})
