import { configure, render, screen } from '@testing-library/react'
import { vi } from 'vitest'
import type { ProfileResponse } from '@/lib/api'
// WHY side-effect import: initializes real i18n so the settings namespace keys
// (including tabAdmin) resolve to text.
import '@/lib/i18n'

configure({ testIdAttribute: 'data-test' })

// HeroUI Tabs measures its cursor with ResizeObserver, absent from jsdom.
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

function foundedProfile(): ProfileResponse {
  return {
    id: 'founder-1',
    username: 'zcharef',
    displayName: 'Zayed',
    avatarUrl: null,
    bannerUrl: null,
    bio: null,
    status: 'online',
    customStatus: null,
    isFounding: false,
    // The flag under test: only the founder receives this on /profiles/me.
    isPlatformAdmin: true,
    avatarModerationStatus: 'approved',
    bannerModerationStatus: 'approved',
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-01T00:00:00Z',
  }
}

function mutationStub() {
  return { mutate: vi.fn(), isPending: false, isError: false, error: null }
}

vi.mock('@/features/auth', () => ({
  AvatarUploadError: class AvatarUploadError extends Error {},
  useCurrentProfile: () => ({ data: foundedProfile(), isPending: false }),
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

vi.mock('@/lib/platform', () => ({ isTauri: () => false }))

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

test('reveals the Admin tab when the profile is a platform admin (founder)', () => {
  render(<UserSettingsModal />)

  expect(screen.getByTestId('user-settings-tab-admin')).toBeTruthy()
})
