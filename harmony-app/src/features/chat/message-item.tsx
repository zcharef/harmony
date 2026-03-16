import { Avatar } from '@heroui/react'
import { memo } from 'react'
import type { MessageResponse } from '@/lib/api'

/**
 * WHY: Format ISO timestamp to a human-readable relative format.
 * Keeps it simple for MVP — no i18n library needed yet.
 */
function formatTimestamp(iso: string): string {
  const date = new Date(iso)
  const now = new Date()
  const isToday = date.toDateString() === now.toDateString()

  const time = date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })

  if (isToday) return `Today at ${time}`
  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} at ${time}`
}

/**
 * WHY React.memo: The virtualizer re-renders all visible items when the
 * messages array reference changes (on every new message via realtime or
 * pagination). Memoizing skips re-render for messages whose props haven't
 * changed — only the new message actually renders.
 */
export const MessageItem = memo(function MessageItem({
  message,
}: {
  message: MessageResponse
}) {
  // WHY: authorId is a UUID — use first 8 chars as label fallback.
  // A proper profile lookup would be a future enhancement.
  const authorLabel = message.authorId.slice(0, 8)

  return (
    <div className="group flex gap-4 px-4 py-1 hover:bg-default-200/50">
      <Avatar
        name={authorLabel}
        color="primary"
        size="md"
        classNames={{
          base: 'mt-0.5 h-10 w-10 shrink-0',
          name: 'text-sm',
        }}
      />
      <div className="flex min-w-0 flex-col">
        <div className="flex items-baseline gap-2">
          <span className="cursor-pointer font-medium text-foreground hover:underline">
            {authorLabel}
          </span>
          <span className="text-xs text-default-500">{formatTimestamp(message.createdAt)}</span>
        </div>
        <p className="text-sm text-foreground/90">{message.content}</p>
      </div>
    </div>
  )
})
