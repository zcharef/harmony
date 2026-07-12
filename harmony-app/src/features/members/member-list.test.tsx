import { configure, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useCreateDm } from '@/features/dms'
import type { MemberListResponse } from '@/lib/api'
// WHY side-effect import: initializes the real i18n instance so the members +
// profiles namespace keys (e.g. the official aria-label) resolve to text.
import '@/lib/i18n'
import { queryKeys } from '@/lib/query-keys'
import { createQueryWrapper, createTestQueryClient } from '@/tests/test-utils'
import { MemberList } from './member-list'

// WHY: The repo uses data-test (not data-testid).
configure({ testIdAttribute: 'data-test' })

// The DM creation flow is the canonical hook; stub it so the integration test
// asserts the wiring (mutate → onSuccess → onNavigateDm), not the network.
vi.mock('@/features/dms', () => ({ useCreateDm: vi.fn() }))

const SERVER = 'server-1'

function memberList(): MemberListResponse {
  return {
    items: [
      {
        userId: 'user-42',
        username: 'staff',
        displayName: 'Staff Member',
        avatarUrl: null,
        nickname: null,
        role: 'member',
        isFounding: false,
        joinedAt: '2026-03-01T00:00:00Z',
      },
    ],
    nextCursor: null,
  }
}

function renderList({ officialUserIds }: { officialUserIds: string[] }) {
  const queryClient = createTestQueryClient()
  queryClient.setQueryData(queryKeys.servers.members(SERVER), memberList())
  queryClient.setQueryData(queryKeys.badges.official(), { userIds: officialUserIds })
  render(<MemberList serverId={SERVER} serverName="Server" onNavigateDm={vi.fn()} />, {
    wrapper: createQueryWrapper(queryClient),
  })
}

describe('MemberList official badge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(useCreateDm).mockReturnValue({ mutate: vi.fn() } as never)
  })

  it('renders the Official badge next to a member in the official set', () => {
    renderList({ officialUserIds: ['user-42'] })

    expect(screen.getByTestId('official-badge')).toBeTruthy()
    expect(screen.getByLabelText('Harmony Official')).toBeTruthy()
  })

  it('does NOT render the Official badge for a member outside the set', () => {
    renderList({ officialUserIds: ['someone-else'] })

    expect(screen.getByTestId('member-item')).toBeTruthy()
    expect(screen.queryByTestId('official-badge')).toBeNull()
  })
})

describe('MemberList profile-card DM action', () => {
  beforeEach(() => vi.clearAllMocks())

  it('opens a member card, clicks Message → createDm.mutate + onNavigateDm fire with the DM route', async () => {
    // mutate immediately resolves via its onSuccess, mirroring useCreateDm.
    const mutate = vi.fn((_userId: string, opts: { onSuccess: (data: unknown) => void }) => {
      opts.onSuccess({
        serverId: 'dm-server-9',
        channelId: 'dm-channel-9',
        recipient: { id: 'user-42' },
      })
    })
    vi.mocked(useCreateDm).mockReturnValue({ mutate } as never)

    const onNavigateDm = vi.fn()
    const queryClient = createTestQueryClient()
    queryClient.setQueryData(queryKeys.servers.members(SERVER), memberList())
    queryClient.setQueryData(queryKeys.badges.official(), { userIds: [] })
    render(<MemberList serverId={SERVER} serverName="Server" onNavigateDm={onNavigateDm} />, {
      wrapper: createQueryWrapper(queryClient),
    })

    // Left-click the member → opens the ProfileCard popover.
    fireEvent.click(screen.getByTestId('member-item'))
    const messageButton = await screen.findByTestId('profile-card-message')
    fireEvent.click(messageButton)

    expect(mutate).toHaveBeenCalledTimes(1)
    expect(mutate).toHaveBeenCalledWith('user-42', expect.any(Object))
    expect(onNavigateDm).toHaveBeenCalledWith('dm-server-9', 'dm-channel-9')
  })
})
