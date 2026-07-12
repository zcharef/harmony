import type { MessageResponse } from '@/lib/api'
import { OPTIMISTIC_ID_PREFIX } from './optimistic-id'

/**
 * Virtualizer row model for the chat area: a message row (with grouping
 * metadata), a date separator row, or the "new messages" divider row.
 *
 * WHY extracted from chat-area.tsx: pure list-shaping logic with no React
 * dependency — extraction enables direct unit testing of the grouping rules
 * (same pattern as voice/lib/resolve-participant-name.ts).
 */
export type VirtualItem =
  | { type: 'message'; msg: MessageResponse; isGrouped: boolean }
  | { type: 'date'; label: string }
  | { type: 'new-messages' }

/**
 * Options controlling the "new messages" divider. `null` disables the divider
 * entirely (e.g. while the read-state request is in flight, or on a channel
 * with no open view).
 */
export interface DividerOptions {
  /** Frozen `lastReadAt` (ISO). `null` = never read (divider may sit at the very top). */
  dividerAnchorAt: string | null
  /** The current user's id — their own messages never count as unread. */
  currentUserId: string
}

const GROUPING_THRESHOLD_MS = 5 * 60 * 1000

/**
 * Divider placement predicate (unread-divider ticket §1.2) — byte-for-byte the
 * same "unread" definition the server uses in `list_all_for_user`:
 *   createdAt > anchor AND authorId !== me AND type !== 'system' AND not optimistic.
 * Timestamp comparison (not id-equality) is deliberate so it degrades for the
 * never-read (`anchorAt === null`) and unloaded-boundary cases.
 */
function isFirstUnread(
  msg: MessageResponse,
  anchorAt: string | null,
  currentUserId: string,
): boolean {
  if (msg.authorId === currentUserId) return false
  if (msg.messageType === 'system') return false
  if (msg.id.startsWith(OPTIMISTIC_ID_PREFIX)) return false
  if (anchorAt === null) return true
  return new Date(msg.createdAt).getTime() > new Date(anchorAt).getTime()
}

function getDateLabel(date: Date, today: Date, yesterday: Date): string {
  if (date.toDateString() === today.toDateString()) return 'Today'
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
}

/**
 * Stable identity for a virtual row, used as the virtualizer's `getItemKey`
 * (and the React render key) so react-virtual caches measured heights by row
 * identity — NOT by index. Without this, prepending an older page (fetchNextPage)
 * shifts every index and remaps cached heights onto the wrong rows, producing
 * gaps/overlap until re-measure. Message rows key by message id; the single
 * unread divider by a constant; date rows by their label (each calendar day
 * emits exactly one divider, so labels are unique within a list).
 */
export function virtualItemKey(item: VirtualItem): string {
  switch (item.type) {
    case 'message':
      return item.msg.id
    case 'new-messages':
      return 'new-messages'
    case 'date':
      return `date-${item.label}`
  }
}

export function buildVirtualItems(
  messages: MessageResponse[],
  divider: DividerOptions | null = null,
): VirtualItem[] {
  if (messages.length === 0) return []
  const items: VirtualItem[] = []
  const now = new Date()
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)

  // WHY a single flag: exactly one divider is emitted, before the FIRST message
  // matching §1.2. Placement lives ONLY here (single source of truth for row
  // shaping). A date row for that message is pushed first, so the order is
  // deterministic: date separator, then divider, then the message.
  let dividerInserted = false

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg === undefined) continue
    const msgDate = new Date(msg.createdAt)
    const prev = i > 0 ? messages[i - 1] : undefined

    if (prev === undefined) {
      items.push({ type: 'date', label: getDateLabel(msgDate, now, yesterday) })
    } else {
      const prevDate = new Date(prev.createdAt)
      if (msgDate.toDateString() !== prevDate.toDateString()) {
        items.push({ type: 'date', label: getDateLabel(msgDate, now, yesterday) })
      }
    }

    if (
      divider !== null &&
      !dividerInserted &&
      isFirstUnread(msg, divider.dividerAnchorAt, divider.currentUserId)
    ) {
      items.push({ type: 'new-messages' })
      dividerInserted = true
    }

    // WHY: Deleted messages always break grouping so the "[Message deleted]"
    // placeholder renders with its own header, not collapsed under the previous
    // message. Uses explicit null/undefined checks per CLAUDE.md §philosophy.
    const isGrouped =
      prev !== undefined &&
      (prev.deletedBy === null || prev.deletedBy === undefined) &&
      (msg.deletedBy === null || msg.deletedBy === undefined) &&
      prev.authorId === msg.authorId &&
      prev.messageType === 'default' &&
      msg.messageType === 'default' &&
      msgDate.getTime() - new Date(prev.createdAt).getTime() < GROUPING_THRESHOLD_MS &&
      msgDate.toDateString() === new Date(prev.createdAt).toDateString()

    items.push({ type: 'message', msg, isGrouped })
  }

  return items
}
