import { configure, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MemberListResponse } from '@/lib/api'
// WHY side-effect import: initializes the real i18n instance so the members +
// profiles namespace keys (e.g. the official aria-label) resolve to text.
import '@/lib/i18n'
import { queryKeys } from '@/lib/query-keys'
import { createQueryWrapper, createTestQueryClient } from '@/tests/test-utils'
import { MemberList } from './member-list'

// WHY: The repo uses data-test (not data-testid).
configure({ testIdAttribute: 'data-test' })

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
  beforeEach(() => vi.clearAllMocks())

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
