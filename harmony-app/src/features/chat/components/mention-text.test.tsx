import { configure, render, screen } from '@testing-library/react'
import { vi } from 'vitest'
// WHY: Side-effect import initializes the real i18n instance so pill labels
// resolve to actual translations.
import '@/lib/i18n'
import { createQueryWrapper } from '@/tests/test-utils'
import { MentionText } from './mention-text'

configure({ testIdAttribute: 'data-test' })

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const UUID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'

function renderMentionText(content: string, mentions = [buildMention()]) {
  const Wrapper = createQueryWrapper()
  return render(
    <Wrapper>
      <MentionText content={content} mentions={mentions} serverId={null} />
    </Wrapper>,
  )
}

function buildMention() {
  return { userId: UUID, username: 'alice', displayName: 'Alice Doe', nickname: null }
}

describe('MentionText (E2EE decrypted plaintext)', () => {
  it('renders markers as pills with surrounding text preserved', () => {
    const { container } = renderMentionText(`hey <@${UUID}> hello`)

    expect(screen.getByTestId('mention-pill').textContent).toBe('@Alice Doe')
    expect(container.textContent).toBe('hey @Alice Doe hello')
  })

  it('renders plain text unchanged when no marker is present', () => {
    const { container } = renderMentionText('just plaintext')

    expect(screen.queryByTestId('mention-pill')).toBeNull()
    expect(container.textContent).toBe('just plaintext')
  })

  it('falls back to a muted @unknown-user pill for unresolvable markers', () => {
    renderMentionText(`<@${UUID}>`, [])

    const pill = screen.getByTestId('mention-pill')
    expect(pill.textContent).toBe('@unknown-user')
    expect(pill.getAttribute('data-test-unknown')).toBe('true')
  })

  it('renders one pill per marker', () => {
    renderMentionText(`<@${UUID}> and <@${UUID}>`)

    expect(screen.getAllByTestId('mention-pill')).toHaveLength(2)
  })
})
