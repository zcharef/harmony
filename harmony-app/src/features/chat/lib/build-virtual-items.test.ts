import type { MessageResponse } from '@/lib/api'
import { buildVirtualItems, virtualItemKey } from './build-virtual-items'

// -- Helpers ------------------------------------------------------------------

/** Base timestamp — recent enough that all messages share one date row. */
const BASE_TIME = Date.now() - 60 * 60 * 1000 // 1 hour ago

function buildMessage(overrides: Partial<MessageResponse> = {}): MessageResponse {
  return {
    id: 'msg-1',
    channelId: 'channel-1',
    authorId: 'user-a',
    authorUsername: 'alice',
    authorAvatarUrl: null,
    content: 'hello',
    createdAt: new Date(BASE_TIME).toISOString(),
    editedAt: null,
    deletedBy: null,
    encrypted: false,
    senderDeviceId: null,
    messageType: 'default',
    mentions: [],
    attachments: [],
    embeds: [],
    isPinned: false,
    ...overrides,
  }
}

/** Builds a message offset from BASE_TIME by `offsetMs` (keeps grouping window explicit). */
function messageAt(offsetMs: number, overrides: Partial<MessageResponse> = {}): MessageResponse {
  return buildMessage({
    createdAt: new Date(BASE_TIME + offsetMs).toISOString(),
    ...overrides,
  })
}

/** Extracts only the message rows (skips date separators) with their grouping flag. */
function messageRows(items: ReturnType<typeof buildVirtualItems>) {
  return items.flatMap((item) =>
    item.type === 'message' ? [{ id: item.msg.id, isGrouped: item.isGrouped }] : [],
  )
}

// -- Tests --------------------------------------------------------------------

describe('buildVirtualItems', () => {
  it('returns an empty array for no messages', () => {
    expect(buildVirtualItems([])).toEqual([])
  })

  it('prepends a date separator before the first message', () => {
    const items = buildVirtualItems([buildMessage()])

    expect(items).toHaveLength(2)
    expect(items[0]?.type).toBe('date')
    expect(items[1]?.type).toBe('message')
  })

  it('groups consecutive same-author messages within the 5-minute window', () => {
    const items = buildVirtualItems([messageAt(0, { id: 'a1' }), messageAt(60_000, { id: 'a2' })])

    expect(messageRows(items)).toEqual([
      { id: 'a1', isGrouped: false },
      { id: 'a2', isGrouped: true },
    ])
  })

  // -- Regression: profanity-filter username collapse (reactivity-bug-triage 3.1)
  // A moderator-deleted message between two messages from another user must
  // break grouping — otherwise the second message collapses under the first
  // author's header, misattributing the username.

  it('breaks grouping after a deleted message from another author (B, A-deleted, B)', () => {
    const items = buildVirtualItems([
      messageAt(0, { id: 'b1', authorId: 'user-b' }),
      messageAt(30_000, { id: 'a-deleted', authorId: 'user-a', deletedBy: 'moderator-1' }),
      messageAt(60_000, { id: 'b2', authorId: 'user-b' }),
    ])

    expect(messageRows(items)).toEqual([
      { id: 'b1', isGrouped: false },
      { id: 'a-deleted', isGrouped: false },
      { id: 'b2', isGrouped: false },
    ])
  })

  it('breaks grouping after a deleted message from the same author (A, A-deleted, A)', () => {
    const items = buildVirtualItems([
      messageAt(0, { id: 'a1' }),
      messageAt(30_000, { id: 'a-deleted', deletedBy: 'user-a' }),
      messageAt(60_000, { id: 'a2' }),
    ])

    expect(messageRows(items)).toEqual([
      { id: 'a1', isGrouped: false },
      { id: 'a-deleted', isGrouped: false },
      { id: 'a2', isGrouped: false },
    ])
  })

  it('never groups a deleted message itself, even mid-run of the same author', () => {
    const items = buildVirtualItems([
      messageAt(0, { id: 'a1' }),
      messageAt(30_000, { id: 'a-deleted', deletedBy: 'moderator-1' }),
    ])

    expect(messageRows(items)).toEqual([
      { id: 'a1', isGrouped: false },
      { id: 'a-deleted', isGrouped: false },
    ])
  })

  // -- Other grouping barriers -------------------------------------------------

  it('breaks grouping on author change', () => {
    const items = buildVirtualItems([
      messageAt(0, { id: 'a1', authorId: 'user-a' }),
      messageAt(30_000, { id: 'b1', authorId: 'user-b' }),
    ])

    expect(messageRows(items)).toEqual([
      { id: 'a1', isGrouped: false },
      { id: 'b1', isGrouped: false },
    ])
  })

  it('breaks grouping beyond the 5-minute threshold', () => {
    const items = buildVirtualItems([
      messageAt(0, { id: 'a1' }),
      messageAt(5 * 60 * 1000, { id: 'a2' }),
    ])

    expect(messageRows(items)).toEqual([
      { id: 'a1', isGrouped: false },
      { id: 'a2', isGrouped: false },
    ])
  })

  it('breaks grouping around system messages', () => {
    const items = buildVirtualItems([
      messageAt(0, { id: 'a1' }),
      messageAt(30_000, { id: 'sys', messageType: 'system' }),
      messageAt(60_000, { id: 'a2' }),
    ])

    expect(messageRows(items)).toEqual([
      { id: 'a1', isGrouped: false },
      { id: 'sys', isGrouped: false },
      { id: 'a2', isGrouped: false },
    ])
  })

  it('inserts a date separator on day change and breaks grouping across it', () => {
    const dayMs = 24 * 60 * 60 * 1000
    const items = buildVirtualItems([
      messageAt(-2 * dayMs, { id: 'old' }),
      messageAt(0, { id: 'recent' }),
    ])

    const types = items.map((item) => item.type)
    expect(types).toEqual(['date', 'message', 'date', 'message'])
    expect(messageRows(items)).toEqual([
      { id: 'old', isGrouped: false },
      { id: 'recent', isGrouped: false },
    ])
  })
})

// -- "New messages" divider (unread-divider ticket §1.2 / §7.3) ---------------

const ME = 'me'

/** Index of the divider row, or -1 when absent. */
function dividerIndex(items: ReturnType<typeof buildVirtualItems>) {
  return items.findIndex((item) => item.type === 'new-messages')
}

/** The message id immediately after the divider row (what the divider sits above). */
function idAfterDivider(items: ReturnType<typeof buildVirtualItems>) {
  const idx = dividerIndex(items)
  const next = idx === -1 ? undefined : items[idx + 1]
  return next?.type === 'message' ? next.msg.id : undefined
}

describe('buildVirtualItems — new-messages divider', () => {
  it('renders no divider when opts is null', () => {
    const items = buildVirtualItems([messageAt(0, { id: 'a1', authorId: 'other' })])
    expect(dividerIndex(items)).toBe(-1)
  })

  it('renders no divider when never-read but every message is the caller’s own', () => {
    const items = buildVirtualItems(
      [messageAt(0, { id: 'a1', authorId: ME }), messageAt(10_000, { id: 'a2', authorId: ME })],
      { dividerAnchorAt: null, currentUserId: ME },
    )
    expect(dividerIndex(items)).toBe(-1)
  })

  it('inserts the divider before the first message newer than the anchor from another author', () => {
    const items = buildVirtualItems(
      [
        messageAt(0, { id: 'read', authorId: 'other' }),
        messageAt(20_000, { id: 'unread', authorId: 'other' }),
      ],
      { dividerAnchorAt: new Date(BASE_TIME + 10_000).toISOString(), currentUserId: ME },
    )
    expect(idAfterDivider(items)).toBe('unread')
  })

  it('skips the caller’s own newer messages and places the divider before the next author’s', () => {
    const items = buildVirtualItems(
      [
        messageAt(20_000, { id: 'mine', authorId: ME }),
        messageAt(40_000, { id: 'theirs', authorId: 'other' }),
      ],
      { dividerAnchorAt: new Date(BASE_TIME + 10_000).toISOString(), currentUserId: ME },
    )
    expect(idAfterDivider(items)).toBe('theirs')
  })

  it('does not trigger on a system message newer than the anchor', () => {
    const items = buildVirtualItems(
      [messageAt(20_000, { id: 'sys', authorId: 'other', messageType: 'system' })],
      { dividerAnchorAt: new Date(BASE_TIME + 10_000).toISOString(), currentUserId: ME },
    )
    expect(dividerIndex(items)).toBe(-1)
  })

  it('emits exactly one divider even with many unread messages', () => {
    const items = buildVirtualItems(
      [
        messageAt(20_000, { id: 'u1', authorId: 'other' }),
        messageAt(30_000, { id: 'u2', authorId: 'other' }),
        messageAt(40_000, { id: 'u3', authorId: 'other' }),
      ],
      { dividerAnchorAt: new Date(BASE_TIME + 10_000).toISOString(), currentUserId: ME },
    )
    expect(items.filter((i) => i.type === 'new-messages')).toHaveLength(1)
    expect(idAfterDivider(items)).toBe('u1')
  })

  it('orders a date separator before the divider when both precede the first unread', () => {
    // First message of the loaded window is unread → a date row is emitted for
    // it, then the divider, then the message. Deterministic: date, divider, msg.
    const items = buildVirtualItems([messageAt(20_000, { id: 'u1', authorId: 'other' })], {
      dividerAnchorAt: new Date(BASE_TIME + 10_000).toISOString(),
      currentUserId: ME,
    })
    expect(items.map((i) => i.type)).toEqual(['date', 'new-messages', 'message'])
  })

  it('places the divider at the very top when the channel was never read', () => {
    const items = buildVirtualItems([messageAt(0, { id: 'first', authorId: 'other' })], {
      dividerAnchorAt: null,
      currentUserId: ME,
    })
    expect(idAfterDivider(items)).toBe('first')
  })
})

describe('virtualItemKey', () => {
  it('keys a message row by its message id (stable across index shifts)', () => {
    expect(
      virtualItemKey({ type: 'message', msg: buildMessage({ id: 'msg-42' }), isGrouped: false }),
    ).toBe('msg-42')
  })

  it('keys the unread divider by a constant', () => {
    expect(virtualItemKey({ type: 'new-messages' })).toBe('new-messages')
  })

  it('keys a date row by its label (one divider per calendar day)', () => {
    expect(virtualItemKey({ type: 'date', label: 'Today' })).toBe('date-Today')
  })

  it('produces a stable key for a message even after older rows are prepended', () => {
    // The same message keeps its key whether it is index 0 or index 5 — this is
    // what lets react-virtual carry its measured height across a page prepend.
    const target = buildMessage({ id: 'anchor' })
    const before = buildVirtualItems([target])
    const after = buildVirtualItems([
      messageAt(-40_000, { id: 'older-1', authorId: 'z' }),
      messageAt(-30_000, { id: 'older-2', authorId: 'z' }),
      target,
    ])
    const keyOf = (id: string, items: ReturnType<typeof buildVirtualItems>) =>
      items
        .filter((i) => i.type === 'message')
        .map(virtualItemKey)
        .find((k) => k === id)
    expect(keyOf('anchor', before)).toBe('anchor')
    expect(keyOf('anchor', after)).toBe('anchor')
  })
})
