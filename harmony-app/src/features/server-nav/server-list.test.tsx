import { QueryClient } from '@tanstack/react-query'
import { configure, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MemberListResponse, ServerResponse } from '@/lib/api'
// WHY side-effect import: initializes the real i18n instance so the channels +
// servers namespace keys (Invite People, Server Settings, ...) resolve to text.
import '@/lib/i18n'
import { useSettingsUiStore } from '@/features/settings'
import { queryKeys } from '@/lib/query-keys'
import { createQueryWrapper } from '@/tests/test-utils'
import { ServerList } from './server-list'

// WHY: The repo uses data-test (not data-testid).
configure({ testIdAttribute: 'data-test' })

// WHY: useMyMemberRole (used inside ServerContextMenu for permission gating)
// reads the current user id from useAuthStore. Mock it to a stable id so the
// seeded members cache resolves the caller's role deterministically.
vi.mock('@/features/auth', () => ({
  useAuthStore: vi.fn(),
}))

const { useAuthStore } = await import('@/features/auth')

const CURRENT_USER_ID = 'me'

function buildServer(
  overrides: Partial<ServerResponse> & { id: string; name: string },
): ServerResponse {
  return {
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-01T00:00:00.000Z',
    discoverable: false,
    iconUrl: null,
    isDm: false,
    ownerId: 'someone-else',
    ...overrides,
  }
}

function membersWithSelfRole(role: string): MemberListResponse {
  return {
    items: [
      {
        userId: CURRENT_USER_ID,
        username: 'me',
        displayName: null,
        avatarUrl: null,
        nickname: null,
        role,
        isFounding: false,
        joinedAt: '2026-03-01T00:00:00.000Z',
      },
    ],
    nextCursor: null,
  }
}

const SERVER_ACTIVE = buildServer({ id: 'server-active', name: 'Active Server' })
const SERVER_ADMIN = buildServer({ id: 'server-admin', name: 'Admin Server' })
const SERVER_MEMBER = buildServer({ id: 'server-member', name: 'Member Server' })

function renderRail(onSelectServer = vi.fn()) {
  // WHY staleTime/gcTime Infinity + retry false: the rail fires background
  // queries (channels/dms/friends per icon) with no API in jsdom. Keeping the
  // seeded caches fresh and never garbage-collected stops those failures from
  // flipping the seeded servers list, so the render stays deterministic.
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: Number.POSITIVE_INFINITY,
        staleTime: Number.POSITIVE_INFINITY,
      },
      mutations: { retry: false },
    },
  })
  queryClient.setQueryData(queryKeys.servers.list(), [SERVER_ACTIVE, SERVER_ADMIN, SERVER_MEMBER])
  queryClient.setQueryData(queryKeys.servers.members(SERVER_ADMIN.id), membersWithSelfRole('admin'))
  queryClient.setQueryData(
    queryKeys.servers.members(SERVER_MEMBER.id),
    membersWithSelfRole('member'),
  )
  render(
    <ServerList
      selectedServerId={SERVER_ACTIVE.id}
      view="servers"
      onSelectServer={onSelectServer}
      onSelectDmView={vi.fn()}
    />,
    { wrapper: createQueryWrapper(queryClient) },
  )
  return { onSelectServer }
}

/** Right-clicks the icon of a given server and returns nothing; the menu opens. */
function openContextMenu(serverId: string) {
  const button = document.querySelector(`[data-server-id="${serverId}"]`)
  expect(button).not.toBeNull()
  // biome-ignore lint/style/noNonNullAssertion: asserted non-null above
  fireEvent.contextMenu(button!)
}

beforeEach(() => {
  vi.clearAllMocks()
  useSettingsUiStore.setState({ showServerSettings: false })
  vi.mocked(useAuthStore).mockImplementation((selector: unknown) =>
    (selector as (s: { user: { id: string } }) => string)({ user: { id: CURRENT_USER_ID } }),
  )
})

afterEach(() => {
  useSettingsUiStore.setState({ showServerSettings: false })
})

describe('ServerList context menu', () => {
  it('opens the context menu on right-click of a server icon', async () => {
    renderRail()
    openContextMenu(SERVER_ADMIN.id)

    expect(await screen.findByTestId('server-context-invite-item')).toBeTruthy()
    expect(screen.getByTestId('server-context-leave-item')).toBeTruthy()
  })

  it('shows Settings + Create Channel for an admin', async () => {
    renderRail()

    openContextMenu(SERVER_ADMIN.id)
    expect(await screen.findByTestId('server-context-settings-item')).toBeTruthy()
    expect(screen.getByTestId('server-context-create-channel-item')).toBeTruthy()
  })

  it('hides Settings + Create Channel for a plain member', async () => {
    renderRail()

    openContextMenu(SERVER_MEMBER.id)
    // Invite + Leave stay available; the moderator/admin-gated items are absent.
    expect(await screen.findByTestId('server-context-invite-item')).toBeTruthy()
    expect(screen.getByTestId('server-context-leave-item')).toBeTruthy()
    expect(screen.queryByTestId('server-context-settings-item')).toBeNull()
    expect(screen.queryByTestId('server-context-create-channel-item')).toBeNull()
  })

  it('selects the right-clicked (non-active) server then opens its settings', async () => {
    const onSelectServer = vi.fn()
    renderRail(onSelectServer)

    openContextMenu(SERVER_ADMIN.id)
    fireEvent.click(await screen.findByTestId('server-context-settings-item'))

    // Select-then-act: the right-clicked server becomes active, then settings opens.
    expect(onSelectServer).toHaveBeenCalledWith(SERVER_ADMIN.id)
    expect(useSettingsUiStore.getState().showServerSettings).toBe(true)
  })

  it('selects the right-clicked server then opens its invite dialog', async () => {
    const onSelectServer = vi.fn()
    renderRail(onSelectServer)

    openContextMenu(SERVER_ADMIN.id)
    fireEvent.click(await screen.findByTestId('server-context-invite-item'))

    expect(onSelectServer).toHaveBeenCalledWith(SERVER_ADMIN.id)
    expect(await screen.findByTestId('create-invite-dialog')).toBeTruthy()
  })

  it('selects the right-clicked server then opens its create-channel dialog', async () => {
    const onSelectServer = vi.fn()
    renderRail(onSelectServer)

    openContextMenu(SERVER_ADMIN.id)
    fireEvent.click(await screen.findByTestId('server-context-create-channel-item'))

    expect(onSelectServer).toHaveBeenCalledWith(SERVER_ADMIN.id)
    expect(await screen.findByTestId('create-channel-dialog')).toBeTruthy()
  })

  it('confirms before leaving, targeting the right-clicked server', async () => {
    renderRail()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)

    openContextMenu(SERVER_MEMBER.id)
    fireEvent.click(await screen.findByTestId('server-context-leave-item'))

    expect(confirmSpy).toHaveBeenCalledOnce()
    // The confirm message interpolates the right-clicked server's name.
    expect(confirmSpy.mock.calls[0]?.[0]).toContain(SERVER_MEMBER.name)
    confirmSpy.mockRestore()
  })

  it('does NOT leave when the confirm is dismissed', async () => {
    renderRail()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    openContextMenu(SERVER_MEMBER.id)
    fireEvent.click(await screen.findByTestId('server-context-leave-item'))

    expect(confirmSpy).toHaveBeenCalledOnce()
    // No settings/invite/create side-effects from a Leave action.
    expect(useSettingsUiStore.getState().showServerSettings).toBe(false)
    confirmSpy.mockRestore()
  })
})
