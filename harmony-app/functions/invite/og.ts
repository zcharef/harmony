/**
 * OG-tag building for invite links — pure logic, unit-tested.
 *
 * WHY this exists: the app is a SPA, so crawlers (Discord, Slack, iMessage,
 * Twitter) fetching /invite/:code get a context-free index.html. The Pages
 * Function in [code].ts fetches the public invite preview and injects these
 * tags server-side so a pasted invite unfurls as a real card
 * (growth-plan §7.2: every shared invite is an ad).
 */

// WHY type-only import from the generated client (ADR-015): the API contract
// is the SSoT — a hand-rolled shape would silently drift when the Rust DTO
// changes. `import type` is fully elided at build time (verbatimModuleSyntax),
// so none of the browser-targeting client runtime leaks into the Workers bundle.
import type { InvitePreviewResponse } from '../../src/lib/api'

/** The subset of the public preview response the OG card needs. */
export type InviteOgPreview = Pick<
  InvitePreviewResponse,
  'serverName' | 'serverIconUrl' | 'memberCount'
>

/** Mirrors the API's invite-code format (1-32 alphanumeric chars). */
const INVITE_CODE_REGEX = /^[A-Za-z0-9]{1,32}$/

export function isValidInviteCode(code: string): boolean {
  return INVITE_CODE_REGEX.test(code)
}

/**
 * HTML-escape a value before injecting it into meta tags.
 *
 * WHY: server names are user content. Without escaping, a server named
 * `"><script>...` becomes stored XSS served to every crawler and visitor.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Parse an unknown JSON body into the OG preview shape.
 * Returns null when the shape is wrong — the caller fails open.
 */
export function parseInviteOgPreview(body: unknown): InviteOgPreview | null {
  if (typeof body !== 'object' || body === null) return null
  const record = body as Record<string, unknown>

  if (typeof record.serverName !== 'string' || record.serverName.length === 0) return null
  if (typeof record.memberCount !== 'number') return null

  const icon = record.serverIconUrl
  const serverIconUrl = typeof icon === 'string' && icon.length > 0 ? icon : null

  return {
    serverName: record.serverName,
    serverIconUrl,
    memberCount: record.memberCount,
  }
}

/**
 * Build the OG/Twitter meta block for an invite.
 *
 * `fallbackImageUrl` is used when the server has no icon (the app's own
 * square logo, an absolute URL).
 */
export function buildInviteOgTags(
  preview: InviteOgPreview,
  inviteUrl: string,
  fallbackImageUrl: string,
): string {
  const title = escapeHtml(`Join ${preview.serverName} on Harmony`)
  const memberLabel = preview.memberCount === 1 ? '1 member' : `${preview.memberCount} members`
  const description = escapeHtml(`${memberLabel} · Chat, voice and community on Harmony`)
  const image = escapeHtml(preview.serverIconUrl ?? fallbackImageUrl)
  const url = escapeHtml(inviteUrl)

  return [
    `<meta property="og:type" content="website" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
    `<meta property="og:image" content="${image}" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta name="twitter:card" content="summary" />`,
    `<meta name="twitter:title" content="${title}" />`,
    `<meta name="twitter:description" content="${description}" />`,
    `<meta name="twitter:image" content="${image}" />`,
  ].join('\n    ')
}

/**
 * Inject the tag block right after `<head>`.
 *
 * Fail-open: when no `<head>` is found the original HTML is returned
 * unchanged — a broken unfurl beats a broken page.
 */
export function injectIntoHead(html: string, tags: string): string {
  const headIndex = html.indexOf('<head>')
  if (headIndex === -1) return html

  const insertAt = headIndex + '<head>'.length
  return `${html.slice(0, insertAt)}\n    ${tags}${html.slice(insertAt)}`
}
