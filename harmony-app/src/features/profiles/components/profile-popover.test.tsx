import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { vi } from 'vitest'
import { useAuthStore } from '@/features/auth'
import type { MemberListResponse, ProfileResponse } from '@/lib/api'
// WHY side-effect import: initializes the real i18n instance so the profiles
// namespace keys resolve to text (missing keys would otherwise log).
import '@/lib/i18n'
import { queryKeys } from '@/lib/query-keys'
import { createQueryWrapper, createTestQueryClient } from '@/tests/test-utils'
import { ProfilePopover } from './profile-popover'

// WHY: The repo uses data-test (not data-testid).
configure({ testIdAttribute: 'data-test' })

// Control the tier-2 account fetch — the states under test are its query states.
vi.mock('../hooks/use-profile', () => ({ useProfile: vi.fn() }))
const { useProfile } = await import('../hooks/use-profile')

const SERVER = 'server-1'
const SUBJECT = 'user-subject'

interface ProfileQueryState {
  data?: ProfileResponse
  isPending: boolean
  isError: boolean
  isFetching: boolean
  error: unknown
}

function mockProfileQuery(state: Partial<ProfileQueryState>) {
  vi.mocked(useProfile).mockReturnValue({
    data: state.data,
    isPending: state.isPending ?? false,
    isError: state.isError ?? false,
    isFetching: state.isFetching ?? false,
    error: state.error ?? null,
    refetch: vi.fn(),
  } as never)
}

function buildProfile(overrides: Partial<ProfileResponse> = {}): ProfileResponse {
  return {
    id: SUBJECT,
    username: 'subject',
    displayName: 'Subject Name',
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
    ...overrides,
  }
}

function memberList(): MemberListResponse {
  return {
    items: [
      {
        userId: SUBJECT,
        username: 'subject',
        displayName: 'Subject Name',
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

/** Renders the popover with an optional member-context seed, then opens it. */
function renderAndOpen({
  withContext,
  officialUserIds,
  onStartDm,
}: {
  withContext: boolean
  officialUserIds?: string[]
  onStartDm?: (userId: string) => void
}) {
  const queryClient = createTestQueryClient()
  if (withContext) {
    queryClient.setQueryData(queryKeys.servers.members(SERVER), memberList())
  }
  if (officialUserIds !== undefined) {
    queryClient.setQueryData(queryKeys.badges.official(), { userIds: officialUserIds })
  }
  render(
    <ProfilePopover userId={SUBJECT} serverId={withContext ? SERVER : null} onStartDm={onStartDm}>
      <button type="button" data-test="trigger">
        open
      </button>
    </ProfilePopover>,
    { wrapper: createQueryWrapper(queryClient) },
  )
  fireEvent.click(screen.getByTestId('trigger'))
}

describe('ProfilePopover states', () => {
  beforeEach(() => vi.clearAllMocks())

  it('LOADING (context present): shows the card with a bio-region spinner', async () => {
    mockProfileQuery({ isPending: true })
    renderAndOpen({ withContext: true })

    expect(await screen.findByTestId('profile-card')).toBeTruthy()
    // Name comes from the member context tier immediately.
    expect(screen.getByTestId('profile-card-name').textContent).toBe('Subject Name')
    // Account tier is still loading.
    expect(screen.getByTestId('profile-card-bio-loading')).toBeTruthy()
  })

  it('LOADING (no context): shows the full-card spinner', async () => {
    mockProfileQuery({ isPending: true })
    renderAndOpen({ withContext: false })

    expect(await screen.findByTestId('profile-card-loading')).toBeTruthy()
    expect(screen.queryByTestId('profile-card')).toBeNull()
  })

  it('LOADED with bio: renders the bio and banner image', async () => {
    mockProfileQuery({
      data: buildProfile({
        bio: 'Building things.',
        bannerUrl: 'https://cdn.example.com/banner.webp',
      }),
    })
    renderAndOpen({ withContext: true })

    expect((await screen.findByTestId('profile-bio')).textContent).toContain('Building things.')
    expect(screen.getByTestId('profile-card-banner')).toBeTruthy()
  })

  it('EMPTY bio + banner: omits the bio, shows a flat banner band', async () => {
    mockProfileQuery({ data: buildProfile({ bio: null, bannerUrl: null }) })
    renderAndOpen({ withContext: true })

    expect(await screen.findByTestId('profile-card')).toBeTruthy()
    expect(screen.queryByTestId('profile-bio')).toBeNull()
    expect(screen.getByTestId('profile-card-banner-empty')).toBeTruthy()
  })

  it('USERNAME: shows the @username handle under the display name', async () => {
    mockProfileQuery({ data: buildProfile() })
    renderAndOpen({ withContext: true })

    expect(await screen.findByTestId('profile-card')).toBeTruthy()
    expect(screen.getByTestId('profile-card-name').textContent).toBe('Subject Name')
    expect(screen.getByTestId('profile-card-username').textContent).toBe('@subject')
  })

  it('USERNAME (no context): falls back to the account-tier username', async () => {
    mockProfileQuery({ data: buildProfile() })
    renderAndOpen({ withContext: false })

    expect(await screen.findByTestId('profile-card')).toBeTruthy()
    expect(screen.getByTestId('profile-card-username').textContent).toBe('@subject')
  })

  it('FOUNDING: renders the founding badge in the name row', async () => {
    mockProfileQuery({ data: buildProfile({ isFounding: true }) })
    renderAndOpen({ withContext: true })

    expect(await screen.findByTestId('profile-card')).toBeTruthy()
    expect(screen.getByTestId('founding-badge')).toBeTruthy()
  })

  it('NON-FOUNDING: no founding badge on the card', async () => {
    mockProfileQuery({ data: buildProfile({ isFounding: false }) })
    renderAndOpen({ withContext: true })

    expect(await screen.findByTestId('profile-card')).toBeTruthy()
    expect(screen.queryByTestId('founding-badge')).toBeNull()
  })

  it('OFFICIAL: renders the Harmony Official badge in the name row', async () => {
    mockProfileQuery({ data: buildProfile() })
    renderAndOpen({ withContext: true, officialUserIds: [SUBJECT] })

    expect(await screen.findByTestId('profile-card')).toBeTruthy()
    expect(screen.getByTestId('official-badge')).toBeTruthy()
    expect(screen.getByLabelText('Harmony Official')).toBeTruthy()
  })

  it('NON-OFFICIAL: no official badge on the card', async () => {
    mockProfileQuery({ data: buildProfile() })
    renderAndOpen({ withContext: true, officialUserIds: ['someone-else'] })

    expect(await screen.findByTestId('profile-card')).toBeTruthy()
    expect(screen.queryByTestId('official-badge')).toBeNull()
  })

  it('ERROR (context present, non-404): shows an inline retry, keeps the context tier', async () => {
    mockProfileQuery({ isError: true, error: { status: 500, detail: 'boom' } })
    renderAndOpen({ withContext: true })

    expect(await screen.findByTestId('profile-card')).toBeTruthy()
    expect(screen.getByTestId('profile-card-name').textContent).toBe('Subject Name')
    expect(screen.getByTestId('profile-card-bio-error')).toBeTruthy()
  })

  it('ERROR (no context, non-404): shows the shared error state', async () => {
    mockProfileQuery({ isError: true, error: { status: 500, detail: 'boom' } })
    renderAndOpen({ withContext: false })

    // ErrorState renders a retry button (no profile-card).
    expect(await screen.findByRole('button', { name: /retry/i })).toBeTruthy()
    expect(screen.queryByTestId('profile-card')).toBeNull()
  })

  it('DELETED (404): shows the minimal deleted card', async () => {
    mockProfileQuery({ isError: true, error: { status: 404, detail: 'not found' } })
    renderAndOpen({ withContext: false })

    expect(await screen.findByTestId('profile-card-deleted')).toBeTruthy()
  })
})

describe('ProfilePopover Message action', () => {
  beforeEach(() => vi.clearAllMocks())
  // WHY: isSelf reads useAuthStore; reset it so the "self" test does not leak.
  afterEach(() => useAuthStore.setState({ user: null }))

  it('SHOWS + FIRES: clicking Message calls onStartDm with the subject and closes the card', async () => {
    const onStartDm = vi.fn()
    mockProfileQuery({ data: buildProfile() })
    renderAndOpen({ withContext: true, onStartDm })

    const button = await screen.findByTestId('profile-card-message')
    fireEvent.click(button)

    expect(onStartDm).toHaveBeenCalledTimes(1)
    expect(onStartDm).toHaveBeenCalledWith(SUBJECT)
    // onClose fired → the popover closes and the card unmounts.
    await waitFor(() => expect(screen.queryByTestId('profile-card')).toBeNull())
  })

  it('HIDDEN for self: no Message button, Edit Profile shown instead', async () => {
    useAuthStore.setState({ user: { id: SUBJECT } as never })
    mockProfileQuery({ data: buildProfile() })
    renderAndOpen({ withContext: true, onStartDm: vi.fn() })

    expect(await screen.findByTestId('profile-card')).toBeTruthy()
    expect(screen.queryByTestId('profile-card-message')).toBeNull()
    expect(screen.getByTestId('profile-card-edit')).toBeTruthy()
  })

  it('HIDDEN without the callback: guards the chat/voice/dm surfaces that do not wire it', async () => {
    mockProfileQuery({ data: buildProfile() })
    renderAndOpen({ withContext: true })

    expect(await screen.findByTestId('profile-card')).toBeTruthy()
    expect(screen.queryByTestId('profile-card-message')).toBeNull()
  })
})
