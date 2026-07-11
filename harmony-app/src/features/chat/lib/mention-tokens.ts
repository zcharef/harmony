/**
 * Mention marker grammar + markdown integration (mentions spec §1/§5.1).
 *
 * Canonical marker: `<@` + lowercase-hex UUID + `>` — mirrors the backend
 * scanner in harmony-api/src/domain/services/spam_guard.rs (extract_mentions).
 * Pure functions only — unit-tested in mention-tokens.test.ts.
 */

import { defaultSchema } from 'rehype-sanitize'
import type { MentionedUserResponse } from '@/lib/api'
import { MENTION_MARKER_RE, replaceMentionMarkers } from '@/lib/mention-markers'

// WHY re-export: the marker grammar now lives in `@/lib/mention-markers` (shared
// with the search preview so the format has a single definition). Chat internals
// (mention-text, message-sanitize, the tests) keep importing it from here.
export { MENTION_MARKER_RE }

/** Extract mentioned user IDs from message content (deduplicated, first-appearance order). */
export function extractMentionIds(content: string): string[] {
  const ids: string[] = []
  for (const match of content.matchAll(MENTION_MARKER_RE)) {
    const id = match[1]
    if (id !== undefined && ids.includes(id) === false) {
      ids.push(id)
    }
  }
  return ids
}

/**
 * `@username` token grammar for the composer/edit transform (spec §5.1).
 * Charset + length are DB-constrained (`^[a-z0-9_]{3,32}$`,
 * 20260316013625_create_profiles.sql). Capture group 1 = the boundary
 * (start-of-string or whitespace), group 2 = the username.
 *
 * WHY the boundary group: `@` only counts at start-of-string or after
 * whitespace — the same rule as autocomplete trigger detection — so
 * `bob@alice` (emails, handles) never converts.
 */
const MENTION_TOKEN_RE = /(^|\s)@([a-z0-9_]{3,32})/g

/**
 * Replace `@username` tokens present in `map` with `<@uuid>` markers.
 *
 * Tokens whose username is not in the map (hand-typed, never inserted via the
 * popup) stay plain text — the map is the ONLY source of userId resolution
 * (locked decision: resolution by user_id, spec §9).
 *
 * WHY `mentionedUsers` in the result: the optimistic message needs the full
 * member objects (spec §5.2) so the sender's own pills render instantly;
 * returning them here avoids a second lookup pass at the call site.
 *
 * WHY generic: the composer map stores MentionCandidate (a superset carrying
 * avatarUrl); the generic preserves the caller's exact value type instead of
 * silently widening — no `as` casts at call sites (ADR-035).
 *
 * WHY Map (not Record): usernames are user-controlled keys, and the DB charset
 * `^[a-z0-9_]{3,32}$` permits 'constructor' and '__proto__'. A plain-object
 * lookup walks the prototype chain — `({})['constructor']` is a Function, so
 * '@constructor' in plain text would convert to '<@undefined>' even with an
 * empty map. Map.get has no prototype chain, and Map.set cannot mutate a
 * prototype the way `obj['__proto__'] = x` does.
 */
export function applyMentionMap<T extends MentionedUserResponse>(
  text: string,
  map: ReadonlyMap<string, T>,
): { content: string; mentionedUserIds: string[]; mentionedUsers: T[] } {
  const mentionedUserIds: string[] = []
  const mentionedUsers: T[] = []
  const content = text.replace(
    MENTION_TOKEN_RE,
    (token, boundary: string, username: string): string => {
      const entry = map.get(username)
      if (entry === undefined) return token
      if (mentionedUserIds.includes(entry.userId) === false) {
        mentionedUserIds.push(entry.userId)
        mentionedUsers.push(entry)
      }
      return `${boundary}<@${entry.userId}>`
    },
  )
  return { content, mentionedUserIds, mentionedUsers }
}

/**
 * Inverse transform for the edit buffer (spec §5.3): `<@uuid>` → `@username`
 * for every uuid present in `mentions`. Markers the server never registered
 * (unknown uuid) are left raw and round-trip byte-identical.
 */
export function markersToEditable(content: string, mentions: MentionedUserResponse[]): string {
  if (mentions.length === 0) return content
  return replaceMentionMarkers(content, (userId, marker) => {
    const mention = mentions.find((m) => m.userId === userId)
    return mention === undefined ? marker : `@${mention.username}`
  })
}

/** Build the `username → user` map `applyMentionMap` expects from a message's `mentions`. */
export function mentionsToMap(
  mentions: MentionedUserResponse[],
): Map<string, MentionedUserResponse> {
  return new Map(mentions.map((mention) => [mention.username, mention]))
}

/**
 * rehype-sanitize schema extension: allowlist the pill's data attribute on
 * `span` so mention nodes survive sanitization (spec §5.3). Everything else
 * stays on the library default schema.
 */
export const mentionSanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    span: [...(defaultSchema.attributes?.span ?? []), 'dataMentionId'],
  },
}

/**
 * Minimal structural mdast node type.
 *
 * WHY local (not `import type { Root } from 'mdast'`): `mdast` is a transitive
 * dependency of react-markdown — pnpm's strict layout makes it unimportable
 * without adding a direct dependency for types alone (YAGNI).
 */
interface MdNode {
  type: string
  value?: string
  children?: MdNode[]
  data?: unknown
}

function isMdNode(node: unknown): node is MdNode {
  return typeof node === 'object' && node !== null && 'type' in node
}

/** Build the hast bridge node mdast-util-to-hast turns into `<span data-mention-id>`. */
function buildMentionNode(userId: string): MdNode {
  return {
    type: 'mention',
    data: {
      hName: 'span',
      hProperties: { dataMentionId: userId },
      // WHY hChildren: fallback text if a renderer has no span override —
      // the MessageContent override replaces it with <MentionPill/>.
      hChildren: [{ type: 'text', value: `@${userId}` }],
    },
  }
}

/** Split one text node's value into text/mention nodes. Null = no marker found. */
function splitTextValue(value: string): MdNode[] | null {
  const parts = value.split(MENTION_MARKER_RE)
  if (parts.length === 1) return null

  const nodes: MdNode[] = []
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (part === undefined) continue
    // WHY odd indices: split on a regex with one capture group interleaves
    // [text, uuid, text, uuid, ..., text].
    if (i % 2 === 1) {
      nodes.push(buildMentionNode(part))
    } else if (part.length > 0) {
      nodes.push({ type: 'text', value: part })
    }
  }
  return nodes
}

/**
 * WHY visit only `text` nodes: code / inlineCode nodes carry their content in
 * `value` on a different node type, so markers inside code render raw —
 * matching Discord.
 */
function transformChildren(node: MdNode): void {
  const children = node.children
  if (children === undefined) return

  let index = 0
  while (index < children.length) {
    const child = children[index]
    if (child === undefined) {
      index += 1
      continue
    }
    if (child.type === 'text' && typeof child.value === 'string') {
      const replacement = splitTextValue(child.value)
      if (replacement !== null) {
        children.splice(index, 1, ...replacement)
        index += replacement.length
        continue
      }
    }
    transformChildren(child)
    index += 1
  }
}

/**
 * Remark plugin: replaces `<@uuid>` markers in text nodes with span nodes
 * carrying `data-mention-id`, which MessageContent's span override renders
 * as `<MentionPill/>`.
 */
export function remarkMentions() {
  return (tree: unknown): void => {
    if (isMdNode(tree)) {
      transformChildren(tree)
    }
  }
}
