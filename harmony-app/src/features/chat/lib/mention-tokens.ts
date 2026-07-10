/**
 * Mention marker grammar + markdown integration (mentions spec §1/§5.1).
 *
 * Canonical marker: `<@` + lowercase-hex UUID + `>` — mirrors the backend
 * scanner in harmony-api/src/domain/services/spam_guard.rs (extract_mentions).
 * Pure functions only — unit-tested in mention-tokens.test.ts.
 */

import { defaultSchema } from 'rehype-sanitize'

/**
 * The §1 marker grammar. Capture group 1 = the UUID.
 *
 * WHY no exec/test on this shared instance: it carries the `g` flag, and
 * exec/test mutate `lastIndex`. Consumers use split/matchAll only (both
 * operate on an internal clone, leaving this instance stateless).
 */
export const MENTION_MARKER_RE =
  /<@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>/g

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
