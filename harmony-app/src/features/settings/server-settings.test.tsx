import { configure, render, screen } from '@testing-library/react'
import { vi } from 'vitest'
import type { MemberRole } from '@/features/members'
// WHY: Side-effect import initializes the real i18n instance so the tab labels
// resolve to actual translations.
import '@/lib/i18n'

// WHY: The repo uses data-test (not data-testid) — align Testing Library queries.
configure({ testIdAttribute: 'data-test' })

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const mockRole = vi.fn<() => MemberRole>(() => 'admin')

// WHY: Keep the real ROLE_HIERARCHY (the component compares against it) while
// making the caller's role controllable per test.
vi.mock('@/features/members', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/members')>()
  return {
    ...actual,
    useMyMemberRole: () => ({ role: mockRole(), isLoading: false, isError: false }),
  }
})

vi.mock('@/features/auth', () => ({
  useAuthStore: (selector: (s: { user: { id: string } }) => unknown) =>
    selector({ user: { id: 'user-1' } }),
}))

vi.mock('@/features/server-nav', () => ({
  useServers: () => ({ data: [{ id: 'server-1', name: 'Test Server', ownerId: 'owner-1' }] }),
}))

vi.mock('@/features/moderation', () => ({
  useReports: () => ({ data: { openCount: 0 } }),
  ReportsTab: () => <div data-test="stub-reports-tab" />,
  AuditLogTab: () => <div data-test="stub-audit-tab" />,
}))

vi.mock('@/features/server-emojis', () => ({
  EmojiSettingsTab: () => <div data-test="stub-emojis-tab" />,
}))

vi.mock('./overview-tab', () => ({ OverviewTab: () => <div data-test="stub-overview-tab" /> }))
vi.mock('./discovery-tab', () => ({ DiscoveryTab: () => <div data-test="stub-discovery-tab" /> }))
vi.mock('./roles-tab', () => ({ RolesTab: () => <div data-test="stub-roles-tab" /> }))
vi.mock('./channels-tab', () => ({ ChannelsTab: () => <div data-test="stub-channels-tab" /> }))
vi.mock('./moderation-tab', () => ({
  ModerationTab: () => <div data-test="stub-moderation-tab" />,
}))
vi.mock('./bans-tab', () => ({ BansTab: () => <div data-test="stub-bans-tab" /> }))

const closeServerSettings = vi.fn()
vi.mock('./stores/settings-ui-store', () => ({
  useSettingsUiStore: (selector: (s: { closeServerSettings: () => void }) => unknown) =>
    selector({ closeServerSettings }),
}))

import { ServerSettings } from './server-settings'

const ADMIN_ONLY_TABS = [
  'settings-tab-overview',
  'settings-tab-discovery',
  'settings-tab-roles',
  'settings-tab-channels',
  'settings-tab-emojis',
  'settings-tab-moderation',
  'settings-tab-audit',
  'settings-tab-bans',
]

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ServerSettings permission gating', () => {
  it('shows every tab and defaults to Overview for an admin', () => {
    mockRole.mockReturnValue('admin')
    render(<ServerSettings serverId="server-1" />)

    for (const tab of ADMIN_ONLY_TABS) {
      expect(screen.getByTestId(tab)).toBeDefined()
    }
    expect(screen.getByTestId('settings-tab-reports')).toBeDefined()
    expect(screen.getByTestId('stub-overview-tab')).toBeDefined()
    expect(closeServerSettings).not.toHaveBeenCalled()
  })

  it('shows ONLY the Reports tab and lands on it for a plain moderator', () => {
    mockRole.mockReturnValue('moderator')
    render(<ServerSettings serverId="server-1" />)

    // The reports queue is reachable (mod-dashboard §9 #1: moderator+).
    expect(screen.getByTestId('settings-tab-reports')).toBeDefined()
    expect(screen.getByTestId('stub-reports-tab')).toBeDefined()

    // Admin-only tabs are hidden and the shell is not closed.
    for (const tab of ADMIN_ONLY_TABS) {
      expect(screen.queryByTestId(tab)).toBeNull()
    }
    expect(screen.queryByTestId('stub-overview-tab')).toBeNull()
    expect(closeServerSettings).not.toHaveBeenCalled()
  })

  it('auto-closes for a member (below moderator)', () => {
    mockRole.mockReturnValue('member')
    render(<ServerSettings serverId="server-1" />)

    expect(closeServerSettings).toHaveBeenCalled()
    expect(screen.queryByTestId('settings-tab-reports')).toBeNull()
  })
})
