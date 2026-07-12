import { configure, render, screen } from '@testing-library/react'
import { vi } from 'vitest'
// WHY: side-effect import initializes the real i18n instance so the copy resolves.
import '@/lib/i18n'
import { DmPlaintextBanner } from './dm-plaintext-banner'

vi.mock('@/lib/platform', () => ({ openExternalUrl: vi.fn() }))

configure({ testIdAttribute: 'data-test' })

describe('DmPlaintextBanner', () => {
  it('web variant nudges to the desktop app with a download CTA', () => {
    render(<DmPlaintextBanner variant="web" />)
    expect(screen.getByText(/Use the desktop app for end-to-end encryption/i)).toBeTruthy()
    expect(screen.getByText('Get Desktop App')).toBeTruthy()
  })

  it('defaults to the web variant when no variant is given', () => {
    render(<DmPlaintextBanner />)
    expect(screen.getByText('Get Desktop App')).toBeTruthy()
  })

  it('recipient-keyless variant blames the recipient and drops the download CTA', () => {
    render(<DmPlaintextBanner variant="recipient-keyless" />)
    // Recipient-oriented copy: the RECIPIENT lacks encryption, not the sender.
    expect(screen.getByText(/This person hasn't set up end-to-end encryption yet/i)).toBeTruthy()
    // The user is already on desktop — the download CTA would be a dead action.
    expect(screen.queryByText('Get Desktop App')).toBeNull()
    // The core "not encrypted" fact is still disclosed.
    expect(screen.getByText(/aren't encrypted/i)).toBeTruthy()
  })
})
