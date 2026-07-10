import { QueryClientProvider } from '@tanstack/react-query'
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
// WHY: Side-effect import initializes the real i18n instance so labels resolve
// to actual translations (invite.json / servers.json copy).
import '@/lib/i18n'
import { createTestQueryClient } from '@/tests/test-utils'
import { InviteLandingPage } from './invite-landing-page'

// WHY: The repo uses data-test (not data-testid) — align Testing Library queries.
configure({ testIdAttribute: 'data-test' })

const { previewInviteMock, joinServerMock, useAuthStoreMock } = vi.hoisted(() => ({
  previewInviteMock: vi.fn(),
  joinServerMock: vi.fn(),
  useAuthStoreMock: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  previewInvite: previewInviteMock,
  joinServer: joinServerMock,
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// WHY: LoginPage pulls in supabase/env/captcha — out of scope here. A stub
// keeps the "escalates to auth" assertion cheap and hermetic.
vi.mock('@/features/auth', () => ({
  LoginPage: () => <div data-test="login-page-stub" />,
  useAuthStore: (selector: (s: { session: unknown }) => unknown) => useAuthStoreMock(selector),
}))

const CODE = 'abc123XY'
const SERVER_ID = 'srv-1'

const validPreview = {
  code: CODE,
  serverId: SERVER_ID,
  serverName: 'Test Server',
  serverIconUrl: null,
  memberCount: 42,
  inviterDisplayName: 'Maya',
  inviterAvatarUrl: null,
}

function setSession(session: { user: { id: string } } | null) {
  useAuthStoreMock.mockImplementation((selector: (s: { session: unknown }) => unknown) =>
    selector({ session }),
  )
}

function notFoundError() {
  // WHY: shape matches what the hey-api client throws with throwOnError: true —
  // the parsed RFC 9457 ProblemDetails body, not an Error instance.
  return { status: 404, title: 'Not Found', detail: 'Invite not found' }
}

function renderPage(onDone = vi.fn()) {
  const queryClient = createTestQueryClient()
  // WHY: useInvitePreview overrides `retry` (3x for non-404s), which defeats
  // the test client's retry:false. Zero delay keeps those retries instant so
  // the error state renders within the waitFor window.
  queryClient.setDefaultOptions({
    queries: { ...queryClient.getDefaultOptions().queries, retryDelay: 0 },
  })
  render(
    <QueryClientProvider client={queryClient}>
      <InviteLandingPage code={CODE} onDone={onDone} />
    </QueryClientProvider>,
  )
  return { onDone }
}

beforeEach(() => {
  vi.clearAllMocks()
  sessionStorage.clear()
  setSession(null)
})

describe('InviteLandingPage — preview states', () => {
  it('renders server name, member count, and inviter for a valid invite', async () => {
    previewInviteMock.mockResolvedValue({ data: validPreview })

    renderPage()

    await waitFor(() => {
      expect(screen.getByTestId('invite-server-name').textContent).toContain('Test Server')
    })
    expect(screen.getByTestId('invite-member-count').textContent).toBe('42 members')
    expect(screen.getByTestId('invite-inviter').textContent).toContain('Maya invited you')
    expect(screen.getByTestId('invite-accept-button')).toBeTruthy()
  })

  it('renders the server icon when present', async () => {
    previewInviteMock.mockResolvedValue({
      data: { ...validPreview, serverIconUrl: 'https://cdn.example.com/icon.png' },
    })

    renderPage()

    await waitFor(() => {
      expect(screen.getByTestId('invite-server-icon').getAttribute('src')).toBe(
        'https://cdn.example.com/icon.png',
      )
    })
  })

  it('shows the invalid/expired state on 404 without retrying', async () => {
    previewInviteMock.mockRejectedValue(notFoundError())

    renderPage()

    await waitFor(() => {
      expect(screen.getByTestId('invite-invalid')).toBeTruthy()
    })
    expect(screen.getByText(/invalid or has expired/i)).toBeTruthy()
    // WHY: a 404 is definitive — the query must not have retried.
    expect(previewInviteMock).toHaveBeenCalledTimes(1)
  })

  it('invalid state "continue" hands off with a null server', async () => {
    previewInviteMock.mockRejectedValue(notFoundError())
    const { onDone } = renderPage()

    await waitFor(() => {
      expect(screen.getByTestId('invite-continue-button')).toBeTruthy()
    })
    fireEvent.click(screen.getByTestId('invite-continue-button'))

    expect(onDone).toHaveBeenCalledWith(null)
  })

  it('shows a retryable error state on non-404 failures', async () => {
    previewInviteMock.mockRejectedValue({ status: 500, title: 'Oops', detail: 'boom' })

    renderPage()

    await waitFor(() => {
      expect(screen.getByTestId('invite-load-error')).toBeTruthy()
    })
    expect(screen.getByTestId('invite-retry-button')).toBeTruthy()
  })
})

describe('InviteLandingPage — pre-auth accept', () => {
  it('escalates to the auth screen and records intent on accept', async () => {
    previewInviteMock.mockResolvedValue({ data: validPreview })

    renderPage()

    await waitFor(() => {
      expect(screen.getByTestId('invite-accept-button')).toBeTruthy()
    })
    // Pre-auth hint is visible
    expect(screen.getByText(/sign in or create an account/i)).toBeTruthy()

    fireEvent.click(screen.getByTestId('invite-accept-button'))

    await waitFor(() => {
      expect(screen.getByTestId('login-page-stub')).toBeTruthy()
    })
    expect(sessionStorage.getItem(`harmony:invite-intent:${CODE}`)).toBe('1')
    expect(joinServerMock).not.toHaveBeenCalled()
  })
})

describe('InviteLandingPage — authed accept', () => {
  it('joins on accept and hands off the joined server id', async () => {
    setSession({ user: { id: 'user-1' } })
    previewInviteMock.mockResolvedValue({ data: validPreview })
    joinServerMock.mockResolvedValue({ data: undefined })
    const { onDone } = renderPage()

    await waitFor(() => {
      expect(screen.getByTestId('invite-accept-button')).toBeTruthy()
    })
    fireEvent.click(screen.getByTestId('invite-accept-button'))

    await waitFor(() => {
      expect(onDone).toHaveBeenCalledWith(SERVER_ID)
    })
    expect(joinServerMock).toHaveBeenCalledWith({
      path: { id: SERVER_ID },
      body: { inviteCode: CODE },
      throwOnError: true,
    })
  })

  it('treats 409 already-a-member as success (straight navigate)', async () => {
    setSession({ user: { id: 'user-1' } })
    previewInviteMock.mockResolvedValue({ data: validPreview })
    joinServerMock.mockRejectedValue({ status: 409, title: 'Conflict', detail: 'Already a member' })
    const { onDone } = renderPage()

    await waitFor(() => {
      expect(screen.getByTestId('invite-accept-button')).toBeTruthy()
    })
    fireEvent.click(screen.getByTestId('invite-accept-button'))

    await waitFor(() => {
      expect(onDone).toHaveBeenCalledWith(SERVER_ID)
    })
  })

  it('renders the API detail inline when the join fails (e.g. banned)', async () => {
    setSession({ user: { id: 'user-1' } })
    previewInviteMock.mockResolvedValue({ data: validPreview })
    joinServerMock.mockRejectedValue({
      status: 403,
      title: 'Forbidden',
      detail: 'You are banned from this server',
    })
    const { onDone } = renderPage()

    await waitFor(() => {
      expect(screen.getByTestId('invite-accept-button')).toBeTruthy()
    })
    fireEvent.click(screen.getByTestId('invite-accept-button'))

    await waitFor(() => {
      expect(screen.getByTestId('invite-join-error').textContent).toBe(
        'You are banned from this server',
      )
    })
    expect(onDone).not.toHaveBeenCalled()
  })

  it('auto-joins when a pre-auth intent was recorded', async () => {
    setSession({ user: { id: 'user-1' } })
    sessionStorage.setItem(`harmony:invite-intent:${CODE}`, '1')
    previewInviteMock.mockResolvedValue({ data: validPreview })
    joinServerMock.mockResolvedValue({ data: undefined })
    const { onDone } = renderPage()

    await waitFor(() => {
      expect(onDone).toHaveBeenCalledWith(SERVER_ID)
    })
    // Intent is single-use.
    expect(sessionStorage.getItem(`harmony:invite-intent:${CODE}`)).toBeNull()
  })
})
