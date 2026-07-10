import { render } from '@testing-library/react'
import { ProfileBio } from './profile-bio'

/**
 * Pins the "links only" bio contract (ticket §5.4): the bio is free markdown on
 * input, but only links + text survive rendering. Every other construct
 * degrades to plain text, and unsafe URL protocols are blocked.
 */
describe('ProfileBio', () => {
  it('renders a markdown link as an anchor with safe rel/target', () => {
    const { container } = render(<ProfileBio bio="See [my site](https://example.com)." />)
    const anchor = container.querySelector('a')
    expect(anchor).not.toBeNull()
    expect(anchor?.getAttribute('href')).toBe('https://example.com')
    expect(anchor?.getAttribute('target')).toBe('_blank')
    expect(anchor?.getAttribute('rel')).toContain('noopener')
    expect(anchor?.textContent).toBe('my site')
  })

  it('autolinks a bare URL', () => {
    const { container } = render(<ProfileBio bio="visit https://example.com now" />)
    const anchor = container.querySelector('a')
    expect(anchor?.getAttribute('href')).toBe('https://example.com')
  })

  it('drops a javascript: link (keeps the text, no anchor)', () => {
    const { container } = render(<ProfileBio bio="[click](javascript:alert(1))" />)
    // The unsafe protocol is stripped by the sanitize schema — no href survives.
    const anchor = container.querySelector('a')
    expect(anchor?.getAttribute('href') ?? '').not.toContain('javascript:')
    expect(container.textContent).toContain('click')
  })

  it('strips bold/heading markup to plain text (links-only allowlist)', () => {
    const { container } = render(<ProfileBio bio={'**bold** and # Heading'} />)
    expect(container.querySelector('strong')).toBeNull()
    expect(container.querySelector('h1')).toBeNull()
    // The visible text is preserved even though the formatting is removed.
    expect(container.textContent).toContain('bold')
    expect(container.textContent).toContain('Heading')
  })

  it('does not render an <img> from markdown image syntax', () => {
    const { container } = render(<ProfileBio bio={'![x](https://cdn.example.com/x.png)'} />)
    expect(container.querySelector('img')).toBeNull()
  })

  it('does not inject a raw <script> tag', () => {
    // react-markdown does not parse raw HTML (no rehype-raw), and the sanitize
    // schema's allowlist would strip it anyway — the security property is that
    // no <script> element ever reaches the DOM.
    const { container } = render(<ProfileBio bio={'text before <script>alert(1)</script>'} />)
    expect(container.querySelector('script')).toBeNull()
    expect(container.textContent).toContain('text before')
  })
})
