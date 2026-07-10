import { QueryClientProvider } from '@tanstack/react-query'
import { configure, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
// WHY: Side-effect import initializes the real i18n instance so labels resolve
// to actual migration.json copy.
import '@/lib/i18n'
import { createTestQueryClient } from '@/tests/test-utils'
import { MigrationCenter } from './migration-center'

// WHY: The repo uses data-test (not data-testid) — align Testing Library queries.
configure({ testIdAttribute: 'data-test' })

const { getMigrationProgressMock, listNotYetActiveCohortMock } = vi.hoisted(() => ({
  getMigrationProgressMock: vi.fn(),
  listNotYetActiveCohortMock: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  getMigrationProgress: getMigrationProgressMock,
  listNotYetActiveCohort: listNotYetActiveCohortMock,
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const SERVER_ID = 'srv-mig-ui'

const progressPayload = {
  serverId: SERVER_ID,
  alive: {
    membersJoinedWeek1: 3,
    nonOwnerActiveWeek1: 1,
    messagesWeek1: 12,
    distinctSendersWeek1: 2,
    activeDaysWeek1: 1,
    thresholds: {
      membersJoined: 5,
      nonOwnerActive: 3,
      messages: 50,
      distinctSenders: 3,
      activeDays: 2,
    },
  },
  followThrough: {
    membersJoined: 8,
    membersActive: 2,
    membersSentMessage: 1,
    notYetActive: 6,
  },
  recommendedAction: 'seed_conversation',
}

const cohortPayload = {
  items: [
    {
      userId: 'usr-a',
      username: 'ada',
      displayName: 'Ada',
      avatarUrl: null,
      nickname: null,
      joinedAt: '2026-07-01T00:00:00Z',
      hasSentMessage: false,
    },
    {
      userId: 'usr-b',
      username: 'bo',
      displayName: null,
      avatarUrl: null,
      nickname: null,
      joinedAt: '2026-07-02T00:00:00Z',
      hasSentMessage: false,
    },
  ],
  total: 6,
}

function renderCenter() {
  const queryClient = createTestQueryClient()
  render(
    <QueryClientProvider client={queryClient}>
      <MigrationCenter serverId={SERVER_ID} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('MigrationCenter', () => {
  it('shows a loading state while progress is pending', () => {
    // WHY: a never-resolving promise keeps the query in the pending state.
    getMigrationProgressMock.mockReturnValue(new Promise(() => {}))
    listNotYetActiveCohortMock.mockReturnValue(new Promise(() => {}))

    renderCenter()

    expect(screen.getByTestId('migration-loading')).toBeTruthy()
  })

  it('shows an error state when progress fails', async () => {
    getMigrationProgressMock.mockRejectedValue({ status: 500, title: 'Server Error' })
    listNotYetActiveCohortMock.mockReturnValue(new Promise(() => {}))

    renderCenter()

    await waitFor(() => {
      expect(screen.getByText('Could not load migration progress')).toBeTruthy()
    })
  })

  it('renders progress, follow-through stats, the recommended action, and the cohort', async () => {
    getMigrationProgressMock.mockResolvedValue({ data: progressPayload })
    listNotYetActiveCohortMock.mockResolvedValue({ data: cohortPayload })

    renderCenter()

    await waitFor(() => {
      expect(screen.getByTestId('migration-center')).toBeTruthy()
    })

    // Recommended action reflects the payload.
    expect(screen.getByTestId('migration-action').getAttribute('data-action')).toBe(
      'seed_conversation',
    )

    // Follow-through stats.
    expect(screen.getByTestId('stat-joined').textContent).toContain('8')
    expect(screen.getByTestId('stat-notYetActive').textContent).toContain('6')

    // Alive verdict is "too early" while the week-1 window is open (isAlive absent).
    expect(screen.getByTestId('migration-alive-status').textContent).toContain('Too early to tell')

    // Cohort lists the two not-yet-active members.
    const members = await screen.findAllByTestId('cohort-member')
    expect(members).toHaveLength(2)
    expect(screen.getByText('Ada')).toBeTruthy()
    // The second member has no display name → falls back to username.
    expect(screen.getByText('bo')).toBeTruthy()
  })

  it('shows the empty cohort message when everyone is participating', async () => {
    getMigrationProgressMock.mockResolvedValue({ data: progressPayload })
    listNotYetActiveCohortMock.mockResolvedValue({ data: { items: [], total: 0 } })

    renderCenter()

    await waitFor(() => {
      expect(screen.getByText('Everyone who joined has taken part. Nothing to chase.')).toBeTruthy()
    })
  })

  it('surfaces a cohort failure instead of the reassuring empty copy when the fetch errors', async () => {
    // WHY (regression): a failed cohort fetch leaves items empty. Collapsing it
    // into the 'empty' state would tell the owner "nothing to chase" while the
    // intervention list silently failed to load (ADR-045 silent-failure).
    getMigrationProgressMock.mockResolvedValue({ data: progressPayload })
    listNotYetActiveCohortMock.mockRejectedValue({ status: 500, title: 'Server Error' })

    renderCenter()

    await waitFor(() => {
      expect(screen.getByText('Could not load who still needs a nudge.')).toBeTruthy()
    })
    // The reassuring empty copy must NOT appear on a failed fetch.
    expect(screen.queryByText('Everyone who joined has taken part. Nothing to chase.')).toBeNull()
  })
})
