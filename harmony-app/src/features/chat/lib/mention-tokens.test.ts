import type { MentionedUserResponse } from '@/lib/api'
import { maskProfanity } from '@/lib/profanity-filter'
import {
  applyMentionMap,
  extractMentionIds,
  MENTION_MARKER_RE,
  markersToEditable,
  mentionSanitizeSchema,
  mentionsToMap,
  remarkMentions,
} from './mention-tokens'

const UUID_A = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
const UUID_B = '0e02b2c3-d479-4372-a567-f47ac10b58cc'

const ALICE: MentionedUserResponse = {
  userId: UUID_A,
  username: 'alice',
  displayName: 'Alice',
  nickname: null,
}
const BOB: MentionedUserResponse = {
  userId: UUID_B,
  username: 'bob_42',
  displayName: null,
  nickname: 'Bobby',
}
const MAP = new Map([
  ['alice', ALICE],
  ['bob_42', BOB],
])

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

// ── applyMentionMap ───────────────────────────────────────────────────

describe('applyMentionMap', () => {
  it('converts @username at start-of-string', () => {
    const result = applyMentionMap('@alice hello', MAP)
    expect(result.content).toBe(`<@${UUID_A}> hello`)
    expect(result.mentionedUserIds).toEqual([UUID_A])
    expect(result.mentionedUsers).toEqual([ALICE])
  })

  it('converts @username after whitespace (space and newline)', () => {
    const result = applyMentionMap('hey @alice\n@bob_42 hi', MAP)
    expect(result.content).toBe(`hey <@${UUID_A}>\n<@${UUID_B}> hi`)
    expect(result.mentionedUserIds).toEqual([UUID_A, UUID_B])
  })

  it('does NOT convert bob@alice (boundary rule — emails and handles stay text)', () => {
    const result = applyMentionMap('mail bob@alice today', MAP)
    expect(result.content).toBe('mail bob@alice today')
    expect(result.mentionedUserIds).toEqual([])
  })

  it('leaves usernames not present in the map as plain text', () => {
    const result = applyMentionMap('@stranger hello', MAP)
    expect(result.content).toBe('@stranger hello')
    expect(result.mentionedUserIds).toEqual([])
  })

  it('deduplicates repeated mentions of the same user', () => {
    const result = applyMentionMap('@alice and @alice again', MAP)
    expect(result.content).toBe(`<@${UUID_A}> and <@${UUID_A}> again`)
    expect(result.mentionedUserIds).toEqual([UUID_A])
    expect(result.mentionedUsers).toEqual([ALICE])
  })

  it('does not convert uppercase or invalid-charset tokens (username charset is [a-z0-9_])', () => {
    const result = applyMentionMap('@Alice @al', new Map([...MAP, ['al', ALICE]]))
    // @Alice: uppercase never matches the token grammar. @al: too short (<3).
    expect(result.content).toBe('@Alice @al')
    expect(result.mentionedUserIds).toEqual([])
  })

  // WHY these regressions: 'constructor' and '__proto__' are valid usernames
  // (^[a-z0-9_]{3,32}$). A Record-backed map resolved them through the
  // prototype chain — '@constructor' with an EMPTY map became '<@undefined>'.
  it('leaves @constructor and @__proto__ plain with an empty map (no prototype-chain hit)', () => {
    const result = applyMentionMap(
      'hey @constructor and @__proto__ look',
      new Map<string, MentionedUserResponse>(),
    )
    expect(result.content).toBe('hey @constructor and @__proto__ look')
    expect(result.mentionedUserIds).toEqual([])
    expect(result.mentionedUsers).toEqual([])
  })

  it('converts @constructor and @__proto__ when registered as real map keys', () => {
    const constructorUser: MentionedUserResponse = { ...ALICE, username: 'constructor' }
    const protoUser: MentionedUserResponse = { ...BOB, username: '__proto__' }
    const map = mentionsToMap([constructorUser, protoUser])

    const result = applyMentionMap('@constructor @__proto__', map)

    expect(result.content).toBe(`<@${UUID_A}> <@${UUID_B}>`)
    expect(result.mentionedUserIds).toEqual([UUID_A, UUID_B])
    // The map stays plain data — no prototype mutation from the '__proto__' key.
    expect(Object.getPrototypeOf(map)).toBe(Map.prototype)
  })

  it('handles consecutive mentions separated by single spaces', () => {
    const result = applyMentionMap('@alice @bob_42', MAP)
    expect(result.content).toBe(`<@${UUID_A}> <@${UUID_B}>`)
    expect(result.mentionedUserIds).toEqual([UUID_A, UUID_B])
  })
})

// ── markersToEditable ─────────────────────────────────────────────────

describe('markersToEditable', () => {
  it('rehydrates known markers to @username', () => {
    expect(markersToEditable(`hey <@${UUID_A}>!`, [ALICE])).toBe('hey @alice!')
  })

  it('leaves unknown markers raw (server never registered them)', () => {
    expect(markersToEditable(`hey <@${UUID_A}>`, [BOB])).toBe(`hey <@${UUID_A}>`)
  })

  it('returns content untouched when mentions is empty', () => {
    const content = `hey <@${UUID_A}>`
    expect(markersToEditable(content, [])).toBe(content)
  })

  it('round-trips markersToEditable → applyMentionMap back to the same markers', () => {
    const original = `ping <@${UUID_A}> and <@${UUID_B}> now`
    const editable = markersToEditable(original, [ALICE, BOB])
    expect(editable).toBe('ping @alice and @bob_42 now')
    const { content } = applyMentionMap(editable, mentionsToMap([ALICE, BOB]))
    expect(content).toBe(original)
  })

  it('round-trips unknown markers byte-identical through both transforms', () => {
    const original = `raw <@${UUID_B}> marker`
    const editable = markersToEditable(original, [ALICE])
    expect(editable).toBe(original)
    const { content } = applyMentionMap(editable, mentionsToMap([ALICE]))
    expect(content).toBe(original)
  })

  it('a mangled partial edit degrades to plain text (no marker resurrection)', () => {
    // User deletes part of the rehydrated @username: "@alice" → "@alic".
    const editable = 'hey @alic'
    const { content, mentionedUserIds } = applyMentionMap(editable, mentionsToMap([ALICE]))
    expect(content).toBe('hey @alic')
    expect(mentionedUserIds).toEqual([])
  })
})

// ── mentionsToMap ─────────────────────────────────────────────────────

describe('mentionsToMap', () => {
  it('keys mention objects by username', () => {
    expect(mentionsToMap([ALICE, BOB])).toEqual(
      new Map([
        ['alice', ALICE],
        ['bob_42', BOB],
      ]),
    )
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
