import { configure, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { MessageResponse } from '@/lib/api'
import { SearchResultItem } from './search-result-item'

configure({ testIdAttribute: 'data-test' })

const UUID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'

function message(over: Partial<MessageResponse> = {}): MessageResponse {
  return {
    id: 'm1',
    channelId: 'c1',
    authorId: 'a1',
    authorUsername: 'alice',
    authorDisplayName: 'Alice Doe',
    content: 'hello world from search',
    encrypted: false,
    messageType: 'default',
    mentions: [],
    attachments: [],
    reactions: [],
    createdAt: '2026-01-05T15:04:00.000Z',
    ...over,
  }
}

describe('SearchResultItem', () => {
  it('renders the author display name, a timestamp, and highlighted term', () => {
    const { container } = render(
      <SearchResultItem message={message()} highlightTerms={['hello']} onSelect={vi.fn()} />,
    )

    expect(screen.getByText('Alice Doe')).toBeTruthy()
    // The matched term is wrapped in a <mark>.
    const mark = screen.getByTestId('search-highlight')
    expect(mark.textContent).toBe('hello')
    // A time separator proves the timestamp rendered.
    expect(container.textContent).toContain(':')
  })

  it('fires onSelect (jump-to-channel) when the row is pressed', () => {
    const onSelect = vi.fn()
    render(<SearchResultItem message={message()} highlightTerms={[]} onSelect={onSelect} />)

    fireEvent.click(screen.getByTestId('search-result-item'))
    expect(onSelect).toHaveBeenCalledOnce()
  })

  it('replaces <@uuid> mention markers with @name in the preview', () => {
    const { container } = render(
      <SearchResultItem
        message={message({
          content: `ping <@${UUID}> now`,
          mentions: [{ userId: UUID, username: 'bob', displayName: 'Bobby', nickname: null }],
        })}
        highlightTerms={[]}
        onSelect={vi.fn()}
      />,
    )
    expect(container.textContent).toContain('ping @Bobby now')
  })
})
