import { configure, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
// WHY side-effect import: initializes the real i18n instance so the profiles
// namespace keys (foundingTooltip / foundingLabel) resolve to text.
import '@/lib/i18n'
import { FoundingBadge } from './founding-badge'

// WHY: The repo uses data-test (not data-testid).
configure({ testIdAttribute: 'data-test' })

describe('FoundingBadge', () => {
  it('renders the badge for a founding member', () => {
    render(<FoundingBadge isFounding={true} />)
    const badge = screen.getByTestId('founding-badge')
    expect(badge).toBeTruthy()
    // The accessible label comes from the profiles namespace.
    expect(screen.getByLabelText('Founding member')).toBeTruthy()
  })

  it('renders nothing for a non-founder', () => {
    const { container } = render(<FoundingBadge isFounding={false} />)
    expect(screen.queryByTestId('founding-badge')).toBeNull()
    expect(container.firstChild).toBeNull()
  })
})
