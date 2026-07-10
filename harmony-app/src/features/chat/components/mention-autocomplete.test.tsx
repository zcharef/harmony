import { configure, fireEvent, render, screen } from '@testing-library/react'
import { vi } from 'vitest'
// WHY: Side-effect import initializes the real i18n instance so the listbox
// label and empty-state row resolve to actual translations.
import '@/lib/i18n'
import type { MentionCandidate } from '../hooks/use-mention-autocomplete'
import { MentionAutocomplete } from './mention-autocomplete'

configure({ testIdAttribute: 'data-test' })

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const ALICE: MentionCandidate = {
  userId: 'user-alice',
  username: 'alice_a',
  displayName: 'Alice',
  nickname: null,
  avatarUrl: null,
}
// WHY same displayName: pins the §9 disambiguation rule — duplicate display
// names stay tellable-apart through the always-visible @username column.
const ALICE_TWIN: MentionCandidate = {
  userId: 'user-alice-2',
  username: 'alice_b',
  displayName: 'Alice',
  nickname: null,
  avatarUrl: null,
}

function renderPopup(overrides: Partial<React.ComponentProps<typeof MentionAutocomplete>> = {}) {
  const onSelect = vi.fn()
  const onClose = vi.fn()
  const utils = render(
    <MentionAutocomplete
      isOpen={true}
      isLoading={false}
      results={[ALICE, ALICE_TWIN]}
      highlightIndex={0}
      onSelect={onSelect}
      onClose={onClose}
      {...overrides}
    />,
  )
  return { onSelect, onClose, ...utils }
}

describe('MentionAutocomplete', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders nothing when closed', () => {
    renderPopup({ isOpen: false })
    expect(screen.queryByTestId('mention-autocomplete')).toBeNull()
  })

  it('renders one row per candidate with display name AND disambiguating @username', () => {
    renderPopup()

    const options = screen.getAllByTestId('mention-option')
    expect(options).toHaveLength(2)
    expect(options[0]?.textContent).toContain('Alice')
    expect(options[0]?.textContent).toContain('@alice_a')
    expect(options[1]?.textContent).toContain('Alice')
    expect(options[1]?.textContent).toContain('@alice_b')
  })

  it('marks exactly the highlighted row as aria-selected', () => {
    renderPopup({ highlightIndex: 1 })

    const options = screen.getAllByTestId('mention-option')
    expect(options[0]?.getAttribute('aria-selected')).toBe('false')
    expect(options[1]?.getAttribute('aria-selected')).toBe('true')
  })

  it('selects a candidate on mousedown (keeps composer focus)', () => {
    const { onSelect } = renderPopup()

    const options = screen.getAllByTestId('mention-option')
    if (options[1] === undefined) throw new Error('expected two options')
    fireEvent.mouseDown(options[1])

    expect(onSelect).toHaveBeenCalledExactlyOnceWith(ALICE_TWIN)
  })

  it('shows the muted "No members found" row when results are empty', () => {
    renderPopup({ results: [] })

    expect(screen.getByTestId('mention-no-results').textContent).toBe('No members found')
    expect(screen.queryAllByTestId('mention-option')).toHaveLength(0)
  })

  it('shows a spinner row while loading and hides result rows', () => {
    renderPopup({ isLoading: true })

    expect(screen.getByTestId('mention-loading')).toBeDefined()
    expect(screen.queryAllByTestId('mention-option')).toHaveLength(0)
  })

  it('exposes the listbox/option roles for the combobox pattern', () => {
    renderPopup()

    const listbox = screen.getByRole('listbox')
    expect(listbox.id).toBe('mention-listbox')
    expect(screen.getAllByRole('option')).toHaveLength(2)
  })
})
