import { configure, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
// WHY side-effect import: initializes the real i18n instance so the profiles
// namespace keys (officialTooltip / officialLabel) resolve to text.
import '@/lib/i18n'
import { OfficialBadge } from './official-badge'

// WHY: The repo uses data-test (not data-testid).
configure({ testIdAttribute: 'data-test' })

describe('OfficialBadge', () => {
  it('renders the badge for a verified official account', () => {
    render(<OfficialBadge isOfficial={true} />)
    expect(screen.getByTestId('official-badge')).toBeTruthy()
    // The accessible label comes from the profiles namespace.
    expect(screen.getByLabelText('Harmony Official')).toBeTruthy()
  })

  it('renders nothing for a non-official account', () => {
    const { container } = render(<OfficialBadge isOfficial={false} />)
    expect(screen.queryByTestId('official-badge')).toBeNull()
    expect(container.firstChild).toBeNull()
  })
})
