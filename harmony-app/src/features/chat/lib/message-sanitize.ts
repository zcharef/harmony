/**
 * rehype-sanitize schema for message content (attachments T1.3, decision D8).
 *
 * Extends the mention schema with `alt`/`title` on `img` so markdown images
 * keep their accessible text. The default schema already allowlists the `img`
 * tag with `src` restricted to http/https, so no `srcset`/event-handler
 * attribute ever survives sanitization.
 *
 * Security note (D8): allowing `<img src>` enables image beacons (a remote
 * host sees the viewer's IP when the image loads). This is standard chat
 * behavior and matches the existing link handling.
 */

import { defaultSchema } from 'rehype-sanitize'
import { mentionSanitizeSchema } from './mention-tokens'

export const messageSanitizeSchema = {
  ...mentionSanitizeSchema,
  attributes: {
    ...mentionSanitizeSchema.attributes,
    img: [...(defaultSchema.attributes?.img ?? []), 'alt', 'title'],
  },
}
