import { configure, fireEvent, render, screen } from '@testing-library/react'
import { vi } from 'vitest'
// WHY: Side-effect import initializes the real i18n instance so onboarding
// copy resolves to actual translations (missing keys would log via mocked logger).
import '@/lib/i18n'
import { OnboardingFlow } from './onboarding-flow'

// WHY: The repo uses data-test (not data-testid) — align Testing Library queries.
configure({ testIdAttribute: 'data-test' })

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// WHY stubs: the real dialogs pull in mutation hooks + modal portals — the
// flow's contract with them is only { isOpen, onClose, onCreated/onJoined/
// onDmCreated }, which the stubs exercise directly.
vi.mock('@/features/server-nav', () => ({
  CreateServerDialog: ({
    isOpen,
    onCreated,
  }: {
    isOpen: boolean
    onCreated: (serverId: string) => void
  }) =>
    isOpen ? (
      <button
        type="button"
        data-test="stub-create-confirm"
        onClick={() => onCreated('server-created-1')}
      >
        stub create
      </button>
    ) : null,
  JoinServerDialog: ({
    isOpen,
    onJoined,
  }: {
    isOpen: boolean
    onJoined: (serverId: string) => void
  }) =>
    isOpen ? (
      <button
        type="button"
        data-test="stub-join-confirm"
        onClick={() => onJoined('server-joined-1')}
      >
        stub join
      </button>
    ) : null,
}))

vi.mock('@/features/dms', () => ({
  UserSearchDialog: ({
    isOpen,
    onDmCreated,
  }: {
    isOpen: boolean
    onDmCreated: (serverId: string, channelId: string) => void
  }) =>
    isOpen ? (
      <button
        type="button"
        data-test="stub-dm-confirm"
        onClick={() => onDmCreated('dm-server-1', 'dm-channel-1')}
      >
        stub dm
      </button>
    ) : null,
}))

function renderFlow(overrides: Partial<Parameters<typeof OnboardingFlow>[0]> = {}) {
  const props = {
    displayName: 'Zed',
    officialServerId: 'official-1',
    onExploreOfficial: vi.fn(),
    onServerCreated: vi.fn(),
    onServerJoined: vi.fn(),
    onDmStarted: vi.fn(),
    onComplete: vi.fn(),
    ...overrides,
  }
  const utils = render(<OnboardingFlow {...props} />)
  return { props, ...utils }
}

describe('OnboardingFlow state machine', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('starts on step 1 with the explore CTA when the official server is present', () => {
    renderFlow()

    expect(screen.getByTestId('onboarding-flow')).toBeDefined()
    expect(screen.getByTestId('onboarding-explore-official')).toBeDefined()
    // Step position is announced for screen readers.
    expect(screen.getByRole('heading').textContent).toContain('Step 1 of 3')
  })

  // WHY: §6.8/§6.9 — self-hosted instances (env unset) and banned users
  // (not a member despite env set) must get the generic welcome, no dead CTA.
  it('hides the explore CTA and adapts copy when officialServerId is null', () => {
    renderFlow({ officialServerId: null })

    expect(screen.queryByTestId('onboarding-explore-official')).toBeNull()
    expect(
      screen.getByText(
        'Harmony is where your communities live — servers, channels, voice, and direct messages.',
      ),
    ).toBeDefined()
  })

  it('explore CTA reports the official server id (select-and-complete path)', () => {
    const { props } = renderFlow()

    fireEvent.click(screen.getByTestId('onboarding-explore-official'))

    expect(props.onExploreOfficial).toHaveBeenCalledOnce()
    expect(props.onExploreOfficial).toHaveBeenCalledWith('official-1')
    expect(props.onComplete).not.toHaveBeenCalled()
  })

  it('walks Next → step 2 → Skip → step 3 → Done, completing exactly once', () => {
    const { props } = renderFlow()

    fireEvent.click(screen.getByTestId('onboarding-next'))
    expect(screen.getByTestId('onboarding-create-card')).toBeDefined()
    expect(screen.getByTestId('onboarding-join-card')).toBeDefined()
    expect(screen.getByRole('heading').textContent).toContain('Step 2 of 3')

    fireEvent.click(screen.getByTestId('onboarding-skip'))
    expect(screen.getByTestId('onboarding-find-people')).toBeDefined()
    expect(screen.getByRole('heading').textContent).toContain('Step 3 of 3')

    fireEvent.click(screen.getByTestId('onboarding-done'))
    expect(props.onComplete).toHaveBeenCalledOnce()
  })

  it('Back returns from step 2 to step 1 without completing', () => {
    const { props } = renderFlow()

    fireEvent.click(screen.getByTestId('onboarding-next'))
    fireEvent.click(screen.getByTestId('onboarding-back'))

    expect(screen.getByRole('heading').textContent).toContain('Step 1 of 3')
    expect(props.onComplete).not.toHaveBeenCalled()
  })

  it('creating a server on step 2 reports the new server id (terminal path)', () => {
    const { props } = renderFlow()

    fireEvent.click(screen.getByTestId('onboarding-next'))
    fireEvent.click(screen.getByTestId('onboarding-create-card'))
    fireEvent.click(screen.getByTestId('stub-create-confirm'))

    expect(props.onServerCreated).toHaveBeenCalledOnce()
    expect(props.onServerCreated).toHaveBeenCalledWith('server-created-1')
  })

  it('joining a server on step 2 reports the joined server id (terminal path)', () => {
    const { props } = renderFlow()

    fireEvent.click(screen.getByTestId('onboarding-next'))
    fireEvent.click(screen.getByTestId('onboarding-join-card'))
    fireEvent.click(screen.getByTestId('stub-join-confirm'))

    expect(props.onServerJoined).toHaveBeenCalledOnce()
    expect(props.onServerJoined).toHaveBeenCalledWith('server-joined-1')
  })

  it('starting a DM on step 3 reports the DM location (terminal path)', () => {
    const { props } = renderFlow()

    fireEvent.click(screen.getByTestId('onboarding-next'))
    fireEvent.click(screen.getByTestId('onboarding-skip'))
    fireEvent.click(screen.getByTestId('onboarding-find-people'))
    fireEvent.click(screen.getByTestId('stub-dm-confirm'))

    expect(props.onDmStarted).toHaveBeenCalledOnce()
    expect(props.onDmStarted).toHaveBeenCalledWith('dm-server-1', 'dm-channel-1')
  })

  it('greets by display name', () => {
    renderFlow({ displayName: 'Zed' })

    expect(screen.getByText("Hey Zed, glad you're here.")).toBeDefined()
  })

  // WHY: The profile query may still be in flight — an empty-name greeting
  // ("Hey , ...") reads broken, so it is omitted entirely.
  it('omits the greeting while the profile is still loading (empty name)', () => {
    renderFlow({ displayName: '' })

    expect(screen.queryByText(/glad you're here/)).toBeNull()
  })
})
