import { configure, render, screen } from '@testing-library/react'
import { vi } from 'vitest'
import type { ChannelResponse } from '@/lib/api'
// WHY: Side-effect import initializes the real i18n instance so the sr-only
// strings resolve to actual translations (missing keys would log via mocked logger).
import '@/lib/i18n'
import { ChannelButton } from './channel-sidebar'
import { useUnreadStore } from './stores/unread-store'

// WHY: The repo uses data-test (not data-testid) — align Testing Library queries.
configure({ testIdAttribute: 'data-test' })

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

function buildChannel(overrides: Partial<ChannelResponse> = {}): ChannelResponse {
  return {
    id: 'channel-1',
    name: 'general',
    channelType: 'text',
    serverId: 'server-1',
    encrypted: false,
    isPrivate: false,
    isReadOnly: false,
    position: 0,
    slowModeSeconds: 0,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function renderChannelButton() {
  return render(
    <ChannelButton
      channel={buildChannel()}
      isActive={false}
      canManageChannels={false}
      onSelect={vi.fn()}
      onEdit={vi.fn()}
      onDelete={vi.fn()}
    />,
  )
}

describe('ChannelButton unread pill accessibility', () => {
  beforeEach(() => {
    useUnreadStore.setState({ counts: {}, mentionCounts: {} })
  })

  it('announces the unread count when there are no mentions (regression: pill must not be silent)', () => {
    useUnreadStore.setState({ counts: { 'channel-1': 3 }, mentionCounts: {} })
    renderChannelButton()

    const pill = screen.getByTestId('channel-unread-pill')
    // Screen readers: the sr-only twin carries the full sentence.
    expect(pill.querySelector('.sr-only')?.textContent).toBe('3 unread')
    // Sighted users: the compact count, hidden from the accessibility tree.
    expect(pill.querySelector('[aria-hidden="true"]')?.textContent).toBe('3')
    // No stray text nodes outside the two spans — everything accessible is deliberate.
    expect(pill.childNodes.length).toBe(2)
  })

  it('announces both counts when there are mentions', () => {
    useUnreadStore.setState({ counts: { 'channel-1': 5 }, mentionCounts: { 'channel-1': 2 } })
    renderChannelButton()

    const pill = screen.getByTestId('channel-unread-pill')
    expect(pill.querySelector('.sr-only')?.textContent).toBe('5 unread, 2 mentions')
    expect(pill.querySelector('[aria-hidden="true"]')?.textContent).toBe('@ 5')
    expect(pill.childNodes.length).toBe(2)
  })

  it('renders no pill when there are zero unreads', () => {
    renderChannelButton()

    expect(screen.queryByTestId('channel-unread-pill')).toBeNull()
  })
})
