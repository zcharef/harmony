import { maskProfanity } from '@/lib/profanity-filter'
import {
  extractMentionIds,
  MENTION_MARKER_RE,
  mentionSanitizeSchema,
  remarkMentions,
} from './mention-tokens'

const UUID_A = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
const UUID_B = '0e02b2c3-d479-4372-a567-f47ac10b58cc'

// ── extractMentionIds ─────────────────────────────────────────────────

describe('extractMentionIds', () => {
  it('extracts a single valid marker', () => {
    expect(extractMentionIds(`hey <@${UUID_A}> hello`)).toEqual([UUID_A])
  })

  it('extracts multiple markers in first-appearance order', () => {
    expect(extractMentionIds(`<@${UUID_B}> and <@${UUID_A}>`)).toEqual([UUID_B, UUID_A])
  })

  it('deduplicates repeated markers', () => {
    expect(extractMentionIds(`<@${UUID_A}> twice <@${UUID_A}>`)).toEqual([UUID_A])
  })

  it('ignores non-UUID garbage markers', () => {
    expect(extractMentionIds('<@abc-def> <@everyone> <@123>')).toEqual([])
  })

  it('rejects uppercase-hex UUIDs (grammar is lowercase-only)', () => {
    expect(extractMentionIds(`<@${UUID_A.toUpperCase()}>`)).toEqual([])
  })

  it('rejects markers missing the closing bracket', () => {
    expect(extractMentionIds(`<@${UUID_A}`)).toEqual([])
  })

  it('returns an empty array for plain text', () => {
    expect(extractMentionIds('no mentions here')).toEqual([])
  })

  it('is stateless across repeated calls (global-flag regex safety)', () => {
    const content = `<@${UUID_A}>`
    expect(extractMentionIds(content)).toEqual([UUID_A])
    expect(extractMentionIds(content)).toEqual([UUID_A])
  })
})

// ── remarkMentions ────────────────────────────────────────────────────

interface TestNode {
  type: string
  value?: string
  children?: TestNode[]
  data?: {
    hName?: string
    hProperties?: { dataMentionId?: string }
    hChildren?: { type: string; value: string }[]
  }
}

function buildTree(children: TestNode[]): TestNode {
  return { type: 'root', children: [{ type: 'paragraph', children }] }
}

function paragraphChildren(tree: TestNode): TestNode[] {
  return tree.children?.[0]?.children ?? []
}

describe('remarkMentions', () => {
  it('splits a text node around the marker into text + span nodes', () => {
    const tree = buildTree([{ type: 'text', value: `hi <@${UUID_A}> yo` }])

    remarkMentions()(tree)

    const children = paragraphChildren(tree)
    expect(children).toHaveLength(3)
    expect(children[0]).toEqual({ type: 'text', value: 'hi ' })
    expect(children[1]?.data?.hName).toBe('span')
    expect(children[1]?.data?.hProperties?.dataMentionId).toBe(UUID_A)
    expect(children[2]).toEqual({ type: 'text', value: ' yo' })
  })

  it('handles a marker-only text node without empty text siblings', () => {
    const tree = buildTree([{ type: 'text', value: `<@${UUID_A}>` }])

    remarkMentions()(tree)

    const children = paragraphChildren(tree)
    expect(children).toHaveLength(1)
    expect(children[0]?.data?.hProperties?.dataMentionId).toBe(UUID_A)
  })

  it('emits one span per marker for multiple mentions', () => {
    const tree = buildTree([{ type: 'text', value: `<@${UUID_A}> and <@${UUID_B}>` }])

    remarkMentions()(tree)

    const ids = paragraphChildren(tree)
      .filter((n) => n.type === 'mention')
      .map((n) => n.data?.hProperties?.dataMentionId)
    expect(ids).toEqual([UUID_A, UUID_B])
  })

  it('recurses into nested nodes (marker inside emphasis)', () => {
    const tree = buildTree([
      { type: 'emphasis', children: [{ type: 'text', value: `<@${UUID_A}>` }] },
    ])

    remarkMentions()(tree)

    const emphasis = paragraphChildren(tree)[0]
    expect(emphasis?.children?.[0]?.data?.hProperties?.dataMentionId).toBe(UUID_A)
  })

  it('leaves invalid markers as plain text', () => {
    const tree = buildTree([{ type: 'text', value: '<@everyone> <@not-a-uuid>' }])

    remarkMentions()(tree)

    expect(paragraphChildren(tree)).toEqual([{ type: 'text', value: '<@everyone> <@not-a-uuid>' }])
  })

  it('does not touch code nodes (value-carrying, non-text type)', () => {
    const tree: TestNode = {
      type: 'root',
      children: [{ type: 'code', value: `<@${UUID_A}>` }],
    }

    remarkMentions()(tree)

    expect(tree.children?.[0]).toEqual({ type: 'code', value: `<@${UUID_A}>` })
  })
})

// ── mentionSanitizeSchema ─────────────────────────────────────────────

describe('mentionSanitizeSchema', () => {
  it('allowlists dataMentionId on span', () => {
    expect(mentionSanitizeSchema.attributes.span).toContain('dataMentionId')
  })
})

// ── Interop: profanity mask must not mangle markers ───────────────────

describe('marker interop', () => {
  it('maskProfanity leaves mention markers intact (UUID hex never matches word patterns)', () => {
    const content = `hello <@${UUID_A}>`
    expect(maskProfanity(content)).toBe(content)
  })

  it('String.split on MENTION_MARKER_RE interleaves text and uuids', () => {
    const parts = `a <@${UUID_A}> b`.split(MENTION_MARKER_RE)
    expect(parts).toEqual(['a ', UUID_A, ' b'])
  })
})
