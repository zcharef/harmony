import type { MessageResponse } from '@/lib/api'

/**
 * Virtualizer row model for the chat area: either a message row (with
 * grouping metadata) or a date separator row.
 *
 * WHY extracted from chat-area.tsx: pure list-shaping logic with no React
 * dependency — extraction enables direct unit testing of the grouping rules
 * (same pattern as voice/lib/resolve-participant-name.ts).
 */
export type VirtualItem =
  | { type: 'message'; msg: MessageResponse; isGrouped: boolean }
  | { type: 'date'; label: string }

const GROUPING_THRESHOLD_MS = 5 * 60 * 1000

function getDateLabel(date: Date, today: Date, yesterday: Date): string {
  if (date.toDateString() === today.toDateString()) return 'Today'
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
}

export function buildVirtualItems(messages: MessageResponse[]): VirtualItem[] {
  if (messages.length === 0) return []
  const items: VirtualItem[] = []
  const now = new Date()
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)

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
