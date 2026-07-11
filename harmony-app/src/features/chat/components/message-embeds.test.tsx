import { configure, fireEvent, render, screen } from '@testing-library/react'
import { vi } from 'vitest'
// WHY: side-effect import initializes the real i18n instance so the render
// helpers resolve their aria-labels/keys (mirrors message-attachments.test).
import '@/lib/i18n'
import type { MessageEmbedResponse } from '@/lib/api'
import { MessageEmbeds } from './message-embeds'

// The components tag test hooks with `data-test`, not the default `data-testid`.
configure({ testIdAttribute: 'data-test' })

const mutateMock = vi.fn()
vi.mock('../hooks/use-remove-embed', () => ({
  useRemoveEmbed: () => ({ mutate: mutateMock, isPending: false }),
}))

function embed(overrides: Partial<MessageEmbedResponse> = {}): MessageEmbedResponse {
  return {
    id: 'emb-1',
    url: 'https://example.com/article',
    title: 'Example Article',
    description: 'A short description.',
    siteName: 'Example Site',
    imageUrl: 'https://cdn.example.com/hero.png',
    ...overrides,
  }
}

function renderEmbeds(embeds: MessageEmbedResponse[], canRemove: boolean) {
  return render(
    <MessageEmbeds messageId="msg-1" channelId="chan-1" embeds={embeds} canRemove={canRemove} />,
  )
}

describe('MessageEmbeds (link-preview cards)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders site name, title, description, and the thumbnail', () => {
    renderEmbeds([embed()], false)
    expect(screen.getByTestId('embed-site').textContent).toBe('Example Site')
    expect(screen.getByTestId('embed-title').textContent).toBe('Example Article')
    expect(screen.getByTestId('embed-description').textContent).toBe('A short description.')
    const img = screen.getByTestId('embed-thumbnail')
    expect(img.getAttribute('src')).toBe('https://cdn.example.com/hero.png')
  })

  /** Privacy hardening: the remote thumbnail loads with no Referer and lazily. */
  it('loads the thumbnail with referrerPolicy=no-referrer and lazy loading', () => {
    renderEmbeds([embed()], false)
    const img = screen.getByTestId('embed-thumbnail')
    expect(img.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(img.getAttribute('loading')).toBe('lazy')
  })

  /** Metadata is TEXT ONLY — markup in a title renders as literal text, never
   * as elements (XSS regression guard). */
  it('renders metadata as text nodes, never HTML', () => {
    renderEmbeds([embed({ title: '<img src=x onerror=alert(1)>', imageUrl: null })], false)
    const title = screen.getByTestId('embed-title')
    expect(title.textContent).toBe('<img src=x onerror=alert(1)>')
    expect(title.querySelector('img')).toBeNull()
  })

  it('falls back to the URL host when the page had no site name', () => {
    renderEmbeds([embed({ siteName: null })], false)
    expect(screen.getByTestId('embed-site').textContent).toBe('example.com')
  })

  it('omits the description block when absent', () => {
    renderEmbeds([embed({ description: null })], false)
    expect(screen.queryByTestId('embed-description')).toBeNull()
  })

  it('hides the remove affordance for non-authors', () => {
    renderEmbeds([embed()], false)
    expect(screen.queryByTestId('embed-remove-button')).toBeNull()
  })

  it('lets the author remove the preview (mutation gets message + embed ids)', () => {
    renderEmbeds([embed()], true)
    fireEvent.click(screen.getByTestId('embed-remove-button'))
    expect(mutateMock).toHaveBeenCalledOnce()
    expect(mutateMock).toHaveBeenCalledWith({ messageId: 'msg-1', embedId: 'emb-1' })
  })

  it('renders one card per embed', () => {
    renderEmbeds([embed(), embed({ id: 'emb-2', title: 'Second' })], false)
    expect(screen.getAllByTestId('message-embed')).toHaveLength(2)
  })

  it('renders nothing for an empty embed list', () => {
    const { container } = renderEmbeds([], true)
    expect(container.firstChild).toBeNull()
  })
})
