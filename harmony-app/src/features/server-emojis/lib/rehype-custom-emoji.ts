/**
 * Custom-emoji render integration for message bodies.
 *
 * WHY a remark plugin (not a standalone rehype pass): the mentions feature
 * already establishes this exact pattern — split `text` nodes, emit a `span`
 * bridge node carrying data attributes, allowlist those attributes in the
 * shared rehype-sanitize schema, and render the span via MessageContent's
 * `span` component override. One pattern per concern (mention-tokens.ts).
 *
 * `:name:` tokens resolve against the server's emoji map. Unknown names — or a
 * name whose URL is not a server-emojis bucket object (defense-in-depth) — stay
 * literal text (Discord parity: never an error, never a broken image).
 */

import type { EmojiResponse } from '@/lib/api'
import { EMOJI_PUBLIC_PATH_MARKER } from './emoji-file'
import { CUSTOM_EMOJI_TOKEN_RE, toEmojiToken } from './emoji-token'

/**
 * rehype-sanitize schema extension: allowlist the emoji span's data attributes
 * so the bridge node survives sanitization. Extends whatever base schema the
 * chat feature already uses (mentions + markdown images).
 */
export function extendSanitizeForEmoji<
  T extends { attributes?: Record<string, ReadonlyArray<unknown>> },
>(base: T): T {
  return {
    ...base,
    attributes: {
      ...base.attributes,
      span: [...(base.attributes?.span ?? []), 'dataEmojiName', 'dataEmojiUrl'],
    },
  }
}

/** Minimal structural mdast node type (local — mirrors mention-tokens.ts). */
interface MdNode {
  type: string
  value?: string
  children?: Array<MdNode>
  data?: unknown
}

function isMdNode(node: unknown): node is MdNode {
  return typeof node === 'object' && node !== null && 'type' in node
}

/** Whether a URL is a server-emojis bucket object (only these ever render). */
function isBucketUrl(url: string): boolean {
  return url.includes(EMOJI_PUBLIC_PATH_MARKER)
}

/** Build the hast bridge node mdast-util-to-hast turns into `<span data-emoji-*>`. */
function buildEmojiNode(name: string, url: string): MdNode {
  return {
    type: 'customEmoji',
    data: {
      hName: 'span',
      hProperties: { dataEmojiName: name, dataEmojiUrl: url },
      // Fallback text if a renderer has no span override — MessageContent's
      // override replaces it with an <img class="inline-emoji">.
      hChildren: [{ type: 'text', value: toEmojiToken(name) }],
    },
  }
}

/**
 * Split one text node's value into text / emoji nodes. Returns `null` when the
 * value contains no resolvable `:name:` token (leave the node untouched).
 */
function splitTextValue(
  value: string,
  emojiMap: ReadonlyMap<string, EmojiResponse>,
): MdNode[] | null {
  // WHY reset lastIndex: the module-level regex is stateful with the `g` flag.
  CUSTOM_EMOJI_TOKEN_RE.lastIndex = 0
  const parts = value.split(CUSTOM_EMOJI_TOKEN_RE)
  if (parts.length === 1) return null

  const nodes: MdNode[] = []
  let matched = false
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (part === undefined) continue
    // WHY odd indices: split on a one-capture-group regex interleaves
    // [text, name, text, name, ..., text].
    if (i % 2 === 1) {
      const emoji = emojiMap.get(part)
      if (emoji !== undefined && isBucketUrl(emoji.url)) {
        nodes.push(buildEmojiNode(part, emoji.url))
        matched = true
      } else {
        // Unknown / off-bucket → literal token text.
        nodes.push({ type: 'text', value: toEmojiToken(part) })
      }
    } else if (part.length > 0) {
      nodes.push({ type: 'text', value: part })
    }
  }
  return matched ? nodes : null
}

function transformChildren(node: MdNode, emojiMap: ReadonlyMap<string, EmojiResponse>): void {
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
      const replacement = splitTextValue(child.value, emojiMap)
      if (replacement !== null) {
        children.splice(index, 1, ...replacement)
        index += replacement.length
        continue
      }
    }
    // WHY skip code/inlineCode: their text lives on non-`text` node types, so
    // `:name:` inside a code span stays literal (Discord parity).
    transformChildren(child, emojiMap)
    index += 1
  }
}

/**
 * Remark plugin: replaces resolvable `:name:` tokens in text nodes with span
 * bridge nodes carrying `data-emoji-name` / `data-emoji-url`. During loading the
 * map is empty ⇒ every token stays literal, then re-renders on cache fill.
 */
export function remarkCustomEmoji(emojiMap: ReadonlyMap<string, EmojiResponse>) {
  return (tree: unknown): void => {
    if (isMdNode(tree)) {
      transformChildren(tree, emojiMap)
    }
  }
}
