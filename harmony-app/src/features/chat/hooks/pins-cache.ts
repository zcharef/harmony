import type { InfiniteData } from '@tanstack/react-query'
import type { MessageListResponse, MessageResponse, PinnedMessagesResponse } from '@/lib/api'

/**
 * Pure cache transforms shared by the pin mutations and the pins realtime
 * handler. Keeping them here (not duplicated per hook) guarantees the optimistic
 * flip and the SSE reconciliation stay byte-for-byte consistent.
 */

/**
 * Flip a single message's `isPinned` flag across every page of the channel's
 * message cache. Only the flag is touched — the inline pinned tag reads it, and
 * the panel is the source of truth for provenance.
 */
export function patchMessagePinned(
  old: InfiniteData<MessageListResponse> | undefined,
  messageId: string,
  isPinned: boolean,
): InfiniteData<MessageListResponse> | undefined {
  if (!old) return undefined
  return {
    ...old,
    pages: old.pages.map((page) => ({
      ...page,
      items: page.items.map((m) => (m.id === messageId ? { ...m, isPinned } : m)),
    })),
  }
}

/**
 * Prepend a freshly-pinned message to the pins list (most-recently-pinned
 * first), deduping by id so an optimistic insert + SSE echo don't double it.
 */
export function prependPin(
  old: PinnedMessagesResponse | undefined,
  message: MessageResponse,
): PinnedMessagesResponse | undefined {
  if (!old) return undefined
  if (old.items.some((m) => m.id === message.id)) return old
  const items = [message, ...old.items]
  return { items, total: items.length }
}

/**
 * Remove a message from the pins list by id (unpin, or a pinned message being
 * deleted). Idempotent — a no-op when the id isn't present.
 */
export function removePin(
  old: PinnedMessagesResponse | undefined,
  messageId: string,
): PinnedMessagesResponse | undefined {
  if (!old) return undefined
  if (!old.items.some((m) => m.id === messageId)) return old
  const items = old.items.filter((m) => m.id !== messageId)
  return { items, total: items.length }
}
