import { Avatar, Button, Textarea } from '@heroui/react'
import { Pencil, Trash2 } from 'lucide-react'
import { memo, useRef, useState } from 'react'
import type { MessageResponse } from '@/lib/api'

interface MessageItemProps {
  message: MessageResponse
  currentUserId: string
  isEditing: boolean
  onStartEdit: () => void
  onSaveEdit: (content: string) => void
  onCancelEdit: () => void
  onDelete: () => void
}

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
  currentUserId,
  isEditing,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onDelete,
}: MessageItemProps) {
  // WHY: authorId is a UUID — use first 8 chars as label fallback.
  // A proper profile lookup would be a future enhancement.
  const authorLabel = message.authorId.slice(0, 8)

  // WHY derive from ID: Optimistic messages use `temp-*` IDs. Deriving pending
  // state from the ID avoids an extra prop and stays in sync automatically —
  // when the real message replaces the optimistic one, the ID changes and
  // pending styling disappears without any manual state management.
  const isPending = message.id.startsWith('temp-')

  const isOwnMessage = message.authorId === currentUserId

  const [editContent, setEditContent] = useState(message.content)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  function handleEditKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      onCancelEdit()
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      const trimmed = editContent.trim()
      if (trimmed.length > 0) {
        onSaveEdit(trimmed)
      }
    }
  }

  return (
    <div
      data-test="message-item"
      data-message-id={message.id}
      className={`group relative flex gap-4 px-4 py-1 hover:bg-default-200/50${isPending ? ' opacity-60' : ''}`}
    >
      <Avatar
        name={authorLabel}
        color="primary"
        size="md"
        classNames={{
          base: 'mt-0.5 h-10 w-10 shrink-0',
          name: 'text-sm',
        }}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-baseline gap-2">
          <span data-test="message-author" className="cursor-pointer font-medium text-foreground hover:underline">
            {authorLabel}
          </span>
          <span className="text-xs text-default-500">
            {isPending ? 'Sending...' : formatTimestamp(message.createdAt)}
          </span>
        </div>

        {isEditing ? (
          <div className="flex flex-col gap-1">
            <Textarea
              ref={textareaRef}
              variant="flat"
              minRows={1}
              maxRows={6}
              value={editContent}
              onValueChange={setEditContent}
              onKeyDown={handleEditKeyDown}
              classNames={{
                inputWrapper: 'bg-default-100',
                input: 'text-sm',
              }}
              autoFocus
            />
            <span className="text-xs text-default-500">
              escape to{' '}
              <button type="button" onClick={onCancelEdit} className="text-primary hover:underline">
                cancel
              </button>
              {' \u2022 '}
              enter to{' '}
              <button
                type="button"
                onClick={() => {
                  const trimmed = editContent.trim()
                  if (trimmed.length > 0) {
                    onSaveEdit(trimmed)
                  }
                }}
                className="text-primary hover:underline"
              >
                save
              </button>
            </span>
          </div>
        ) : (
          <p data-test="message-content" className="text-sm text-foreground/90">
            {message.content}
            {message.editedAt !== undefined && message.editedAt !== null && (
              <span className="ml-1 text-xs text-default-400">(edited)</span>
            )}
          </p>
        )}
      </div>

      {/* WHY: Hover actions only for own messages, hidden during edit mode.
          Uses group-hover to appear on row hover — avoids per-message state. */}
      {isOwnMessage && !isEditing && !isPending && (
        <div className="absolute -top-3 right-4 hidden gap-0.5 rounded-md border border-divider bg-background shadow-sm group-hover:flex">
          <Button variant="light" isIconOnly size="sm" onPress={onStartEdit}>
            <Pencil className="h-4 w-4 text-default-500" />
          </Button>
          <Button variant="light" isIconOnly size="sm" onPress={onDelete}>
            <Trash2 className="h-4 w-4 text-danger" />
          </Button>
        </div>
      )}
    </div>
  )
})
