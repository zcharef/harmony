/**
 * rehype-sanitize schema for profile bios — LINKS ONLY.
 *
 * The bio is free markdown on input, but the product contract (ticket §5.4) is
 * "links only": `[text](url)` and bare-URL autolinks render as anchors; every
 * other construct (bold, italic, headings, images, code, lists) is stripped to
 * plain text by allowlisting just `a`/`p`/`br`. The `protocols` gate blocks
 * `javascript:` / `data:` URLs — the XSS surface. This mirrors the message
 * sanitize approach (features/chat/lib/message-sanitize.ts) with a tighter
 * allowlist.
 */

import { defaultSchema } from 'rehype-sanitize'

export const bioSanitizeSchema = {
  ...defaultSchema,
  // Links + paragraph/line breaks only. Everything else degrades to text.
  tagNames: ['a', 'p', 'br'],
  attributes: {
    a: ['href', ['target', '_blank'], ['rel', 'noreferrer noopener']],
  },
  // No javascript: / data: — only navigable, safe protocols.
  protocols: { href: ['http', 'https', 'mailto'] },
} satisfies typeof defaultSchema
