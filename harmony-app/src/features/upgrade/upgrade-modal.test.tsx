import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// WHY side-effect import: initializes the real i18n instance so the upgrade
// namespace keys resolve to text (missing keys would otherwise log).
import '@/lib/i18n'
import type { PlanGateError } from '@/lib/plan-gate'
import { useUpgradeModalStore } from './stores/upgrade-modal-store'
import { UpgradeModal } from './upgrade-modal'

// WHY: The repo uses data-test (not data-testid).
configure({ testIdAttribute: 'data-test' })

const { recordEventMock } = vi.hoisted(() => ({
  recordEventMock: vi.fn().mockResolvedValue({ data: undefined }),
}))

vi.mock('@/lib/api', () => ({
  recordEvent: recordEventMock,
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

function renderModal() {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
  return render(<UpgradeModal />, { wrapper: Wrapper })
}

const emojiGate: PlanGateError = {
  code: 'FEATURE_NOT_IN_PLAN',
  resource: 'custom_emoji',
  currentPlan: 'free',
  limit: 0,
  requiredPlan: 'supporter',
}

const invitesGate: PlanGateError = {
  code: 'PLAN_LIMIT_REACHED',
  resource: 'active_invites',
  currentPlan: 'free',
  limit: 5,
  requiredPlan: 'supporter',
}

describe('UpgradeModal', () => {
  beforeEach(() => {
    recordEventMock.mockClear()
  })

  afterEach(() => {
    useUpgradeModalStore.getState().close()
  })

  it('renders nothing while no gate is open', () => {
    renderModal()
    expect(screen.queryByTestId('upgrade-modal')).toBeNull()
  })

  it('renders the FEATURE_NOT_IN_PLAN variant with the recommended tier and real numbers', async () => {
    renderModal()
    useUpgradeModalStore.getState().open(emojiGate)

    expect((await screen.findByTestId('upgrade-headline')).textContent).toContain(
      'custom emoji are a Supporter feature',
    )

    // All three tier cards, with the Supporter one recommended.
    expect(screen.queryByTestId('upgrade-tier-free')).not.toBeNull()
    expect(screen.queryByTestId('upgrade-tier-supporter')).not.toBeNull()
    expect(screen.queryByTestId('upgrade-tier-creator')).not.toBeNull()
    expect(screen.queryByTestId('upgrade-recommended-chip')).not.toBeNull()
    expect(
      screen
        .getByTestId('upgrade-tier-supporter')
        .contains(screen.getByTestId('upgrade-recommended-chip')),
    ).toBe(true)

    // Blocked-resource row uses REAL PlanLimits numbers per tier.
    expect(screen.getByTestId('upgrade-resource-row-free').textContent).toContain('Not included')
    expect(screen.getByTestId('upgrade-resource-row-supporter').textContent).toContain('100')
    expect(screen.getByTestId('upgrade-resource-row-creator').textContent).toContain('500')

    // "Current plan" marker sits on the free card.
    expect(screen.getByTestId('upgrade-tier-free').textContent).toContain('Current plan')
  })

  it('renders the PLAN_LIMIT_REACHED variant with limit-aware copy', async () => {
    renderModal()
    useUpgradeModalStore.getState().open(invitesGate)

    expect((await screen.findByTestId('upgrade-headline')).textContent).toContain(
      "You've used all 5 active invites on the Free plan",
    )
    expect(screen.getByTestId('upgrade-resource-row-free').textContent).toContain('5')
    expect(screen.getByTestId('upgrade-resource-row-supporter').textContent).toContain('25')
    expect(screen.getByTestId('upgrade-resource-row-creator').textContent).toContain('100')
  })

  it('emits paywall_viewed once when opened', async () => {
    renderModal()
    useUpgradeModalStore.getState().open(emojiGate)

    await waitFor(() => {
      expect(recordEventMock).toHaveBeenCalledTimes(1)
    })
    expect(recordEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          name: 'paywall_viewed',
          resource: 'custom_emoji',
          code: 'FEATURE_NOT_IN_PLAN',
          currentPlan: 'free',
          recommendedPlan: 'supporter',
        }),
      }),
    )
  })

  it('CTA is a checkout-styled mailto link and emits paywall_cta_clicked', async () => {
    renderModal()
    useUpgradeModalStore.getState().open(emojiGate)

    const cta = await screen.findByTestId('upgrade-cta')
    expect(cta.textContent).toContain('Upgrade to Supporter')
    const href = cta.getAttribute('href') ?? ''
    expect(href.startsWith('mailto:upgrade@joinharmony.app?')).toBe(true)
    expect(href).toContain(encodeURIComponent('Supporter'))

    fireEvent.click(cta)
    await waitFor(() => {
      expect(recordEventMock).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            name: 'paywall_cta_clicked',
            targetPlan: 'supporter',
          }),
        }),
      )
    })
  })

  it('emits paywall_dismissed on "Maybe later" and closes', async () => {
    renderModal()
    useUpgradeModalStore.getState().open(invitesGate)

    const dismiss = await screen.findByTestId('upgrade-maybe-later')
    fireEvent.click(dismiss)

    await waitFor(() => {
      expect(recordEventMock).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            name: 'paywall_dismissed',
            resource: 'active_invites',
            currentPlan: 'free',
          }),
        }),
      )
    })
    expect(useUpgradeModalStore.getState().gate).toBeNull()
  })

  it('does not double-count a dismissal after the CTA was clicked', async () => {
    renderModal()
    useUpgradeModalStore.getState().open(emojiGate)

    fireEvent.click(await screen.findByTestId('upgrade-cta'))
    fireEvent.click(screen.getByTestId('upgrade-maybe-later'))

    await waitFor(() => {
      expect(recordEventMock).toHaveBeenCalledTimes(2)
    })
    const names = recordEventMock.mock.calls.map(
      (call) => (call[0] as { body: { name: string } }).body.name,
    )
    expect(names).toContain('paywall_viewed')
    expect(names).toContain('paywall_cta_clicked')
    expect(names).not.toContain('paywall_dismissed')
  })
})
