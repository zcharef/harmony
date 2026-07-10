import type { MessageResponse } from '@/lib/api'
import { buildVirtualItems } from './build-virtual-items'

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
