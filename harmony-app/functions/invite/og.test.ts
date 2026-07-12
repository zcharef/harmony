import { describe, expect, it } from 'vitest'
import {
  buildInviteOgTags,
  escapeHtml,
  injectIntoHead,
  isValidInviteCode,
  parseInviteOgPreview,
} from './og'

const preview = {
  serverName: 'Test Server',
  serverIconUrl: 'https://cdn.example.com/icon.png',
  memberCount: 42,
}

describe('isValidInviteCode', () => {
  it('accepts 1-32 alphanumeric codes', () => {
    expect(isValidInviteCode('abc123XY')).toBe(true)
    expect(isValidInviteCode('a')).toBe(true)
    expect(isValidInviteCode('a'.repeat(32))).toBe(true)
  })

  it('rejects empty, oversized, and non-alphanumeric codes', () => {
    expect(isValidInviteCode('')).toBe(false)
    expect(isValidInviteCode('a'.repeat(33))).toBe(false)
    expect(isValidInviteCode('abc-123')).toBe(false)
    expect(isValidInviteCode('abc<img>')).toBe(false)
  })
})

describe('escapeHtml', () => {
  it('escapes all HTML-significant characters', () => {
    expect(escapeHtml(`<img src=x onerror="a" & 'b'>`)).toBe(
      '&lt;img src=x onerror=&quot;a&quot; &amp; &#39;b&#39;&gt;',
    )
  })
})

describe('parseInviteOgPreview', () => {
  it('parses a valid preview body', () => {
    expect(parseInviteOgPreview(preview)).toEqual(preview)
  })

  it('normalizes a missing/null icon to null', () => {
    expect(parseInviteOgPreview({ ...preview, serverIconUrl: null })?.serverIconUrl).toBeNull()
    expect(parseInviteOgPreview({ ...preview, serverIconUrl: '' })?.serverIconUrl).toBeNull()
  })

  it('rejects malformed bodies', () => {
    expect(parseInviteOgPreview(null)).toBeNull()
    expect(parseInviteOgPreview('nope')).toBeNull()
    expect(parseInviteOgPreview({})).toBeNull()
    expect(parseInviteOgPreview({ serverName: '', memberCount: 3 })).toBeNull()
    expect(parseInviteOgPreview({ serverName: 'x', memberCount: 'many' })).toBeNull()
  })
})

describe('buildInviteOgTags', () => {
  const url = 'https://app.joinharmony.app/invite/abc123'
  const fallback = 'https://app.joinharmony.app/web-app-manifest-512x512.png'

  it('builds og:title with the server name and og:description with member count', () => {
    const tags = buildInviteOgTags(preview, url, fallback)
    expect(tags).toContain('<meta property="og:title" content="Join Test Server on Harmony" />')
    expect(tags).toContain('content="42 members · Chat, voice and community on Harmony"')
    expect(tags).toContain(
      '<meta property="og:image" content="https://cdn.example.com/icon.png" />',
    )
    expect(tags).toContain(`<meta property="og:url" content="${url}" />`)
    expect(tags).toContain('<meta name="twitter:card" content="summary" />')
  })

  it('singularizes a 1-member community', () => {
    const tags = buildInviteOgTags({ ...preview, memberCount: 1 }, url, fallback)
    expect(tags).toContain('content="1 member · Chat, voice and community on Harmony"')
  })

  it('emits og:url for a short /i/ invite link', () => {
    const shortUrl = 'https://joinharmony.app/i/abc123'
    const tags = buildInviteOgTags(preview, shortUrl, fallback)
    expect(tags).toContain(`<meta property="og:url" content="${shortUrl}" />`)
  })

  it('falls back to the app logo when the server has no icon', () => {
    const tags = buildInviteOgTags({ ...preview, serverIconUrl: null }, url, fallback)
    expect(tags).toContain(`<meta property="og:image" content="${fallback}" />`)
  })

  it('escapes hostile server names (stored XSS guard)', () => {
    const hostile = { ...preview, serverName: `"><script>alert(1)</script>` }
    const tags = buildInviteOgTags(hostile, url, fallback)
    expect(tags).not.toContain('<script>')
    expect(tags).toContain('&quot;&gt;&lt;script&gt;')
  })
})

describe('injectIntoHead', () => {
  it('injects tags right after <head>', () => {
    const html = '<!doctype html><html><head><title>Harmony</title></head><body></body></html>'
    const result = injectIntoHead(html, '<meta property="og:title" content="X" />')
    expect(result.indexOf('og:title')).toBeGreaterThan(result.indexOf('<head>'))
    expect(result.indexOf('og:title')).toBeLessThan(result.indexOf('<title>'))
  })

  it('fails open when no <head> exists', () => {
    const html = '<div>no head</div>'
    expect(injectIntoHead(html, '<meta />')).toBe(html)
  })
})
