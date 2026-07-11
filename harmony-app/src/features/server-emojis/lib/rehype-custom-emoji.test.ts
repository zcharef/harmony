import { describe, expect, it } from 'vitest'
import type { EmojiResponse } from '@/lib/api'
import { buildEmojiMap } from './emoji-token'
import { extendSanitizeForEmoji, remarkCustomEmoji } from './rehype-custom-emoji'

function emoji(name: string, url: string): EmojiResponse {
  return {
    id: `id-${name}`,
    serverId: 's',
    name,
    url,
    isAnimated: false,
    createdBy: 'u',
    createdAt: '2026-01-01T00:00:00Z',
  }
}

const BUCKET = 'https://x.supabase.co/storage/v1/object/public/server-emojis/s'

interface TreeNode {
  type: string
  value?: string
  children?: TreeNode[]
  data?: { hProperties?: Record<string, string> }
}

/** Minimal mdast tree with a single paragraph text node. */
function textTree(value: string): TreeNode {
  return { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', value }] }] }
}

function paragraphChildren(tree: TreeNode): TreeNode[] {
  return tree.children?.[0]?.children ?? []
}

describe('remarkCustomEmoji', () => {
  it('replaces a known `:name:` with an emoji span carrying the bucket url', () => {
    const map = buildEmojiMap([emoji('fire', `${BUCKET}/fire.png`)])
    const tree = textTree('hi :fire: yo')
    remarkCustomEmoji(map)(tree)

    const children = paragraphChildren(tree)
    const emojiNode = children.find((n) => n.type === 'customEmoji')
    expect(emojiNode?.data?.hProperties?.dataEmojiName).toBe('fire')
    expect(emojiNode?.data?.hProperties?.dataEmojiUrl).toBe(`${BUCKET}/fire.png`)
    // Surrounding text is preserved.
    expect(children.map((n) => n.value).filter(Boolean)).toEqual(['hi ', ' yo'])
  })

  it('leaves an unknown `:name:` as literal text', () => {
    const map = buildEmojiMap([])
    const tree = textTree('say :unknown: please')
    remarkCustomEmoji(map)(tree)
    // No emoji node was produced — the text node is untouched.
    expect(paragraphChildren(tree).some((n) => n.type === 'customEmoji')).toBe(false)
  })

  it('does NOT render an emoji whose url is off the bucket (defense-in-depth)', () => {
    const map = buildEmojiMap([emoji('evil', 'https://evil.example/x.png')])
    const tree = textTree('nope :evil: nope')
    remarkCustomEmoji(map)(tree)
    expect(paragraphChildren(tree).some((n) => n.type === 'customEmoji')).toBe(false)
  })

  it('never emits a crafted-name script (only map + bucket urls render)', () => {
    const map = buildEmojiMap([emoji('fire', `${BUCKET}/fire.png`)])
    const tree = textTree(':fire: :javascript_x:')
    remarkCustomEmoji(map)(tree)
    const nodes = paragraphChildren(tree).filter((n) => n.type === 'customEmoji')
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.data?.hProperties?.dataEmojiUrl?.startsWith(BUCKET)).toBe(true)
  })
})

describe('extendSanitizeForEmoji', () => {
  it('allowlists the emoji data attributes on span', () => {
    const base = { attributes: { span: ['dataMentionId'] } }
    const extended = extendSanitizeForEmoji(base)
    expect(extended.attributes.span).toContain('dataMentionId')
    expect(extended.attributes.span).toContain('dataEmojiName')
    expect(extended.attributes.span).toContain('dataEmojiUrl')
  })
})
