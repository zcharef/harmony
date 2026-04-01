import { Avatar, Button, Textarea, Tooltip } from '@heroui/react'
import type { TFunction } from 'i18next'
import { ArrowRight, Lock, LockOpen, MessageSquare, Pencil, Trash2 } from 'lucide-react'
import { memo, useRef, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import type { DecryptResult } from '@/features/crypto'
import { EncryptedMessageContent } from '@/features/crypto'
import type { MessageResponse } from '@/lib/api'
import { isTauri } from '@/lib/platform'

interface MessageItemProps {
  message: MessageResponse
  currentUserId: string
  /** WHY: When true, the delete button appears on ALL messages (not just own). */
  canModerateMessages: boolean
  isEditing: boolean
  /** WHY: When true, hides avatar and header to visually group consecutive same-author messages. */
  isGrouped?: boolean
  onStartEdit: () => void
  onSaveEdit: (content: string) => void
  onCancelEdit: () => void
  onDelete: () => void
  /** WHY: Callback to add a reaction to this message (toggle on). */
  onAddReaction?: (emoji: string) => void
  /** WHY: Callback to remove a reaction from this message (toggle off). */
  onRemoveReaction?: (emoji: string) => void
  /** WHY: Callback to start replying to this message. */
  onReply?: () => void
  /** WHY: When true, encrypted messages are rendered via EncryptedMessageContent (DM Olm). */
  isDm?: boolean
  /** WHY: When true, messages use Megolm channel encryption instead of Olm. */
  isChannelEncrypted?: boolean
  /** WHY: Decrypt function from useEncryptedMessages (Olm DMs), passed from ChatArea. */
  decryptMessage?: (message: MessageResponse, senderIdentityKey?: string) => Promise<DecryptResult>
  /** WHY: Decrypt function from useChannelEncryption (Megolm channels), passed from ChatArea. */
  decryptChannelMessage?: (message: MessageResponse) => Promise<DecryptResult>
  /** WHY: Fast cache lookup from useEncryptedMessages or useChannelEncryption, passed from ChatArea. */
  getCachedPlaintext?: (messageId: string) => string | undefined
}

/**
 * WHY: Format ISO timestamp to a human-readable relative format.
 * Accepts `t` as parameter because this function is defined outside the component.
 */
function formatTimestamp(iso: string, t: TFunction<'messages'>): string {
  const date = new Date(iso)
  const now = new Date()
  const isToday = date.toDateString() === now.toDateString()

  const time = date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })

  if (isToday) return t('todayAt', { time })
  return t('dateAt', {
    date: date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    time,
  })
}

// WHY extracted: Reduces MessageItem cognitive complexity below Biome's limit of 15.
function MessageContent({
  message,
  isEncrypted,
  isDeleted,
  isModeratorDeleted,
  isEditing,
  editContent,
  setEditContent,
  onSaveEdit,
  onCancelEdit,
  decryptMessage,
  getCachedPlaintext,
}: {
  message: MessageResponse
  isEncrypted: boolean
  isDeleted: boolean
  isModeratorDeleted: boolean
  isEditing: boolean
  editContent: string
  setEditContent: (value: string) => void
  onSaveEdit: (content: string) => void
  onCancelEdit: () => void
  decryptMessage?: (msg: MessageResponse, senderIdentityKey?: string) => Promise<DecryptResult>
  getCachedPlaintext?: (messageId: string) => string | undefined
}) {
  const { t } = useTranslation('messages')
  const { t: tCrypto } = useTranslation('crypto')
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

  if (isDeleted) {
    return (
      <p
        data-test="message-content"
        data-test-deleted="true"
        className="text-sm italic text-default-400"
      >
        {isModeratorDeleted ? t('removedByModerator') : t('deletedMessage')}
      </p>
    )
  }

  if (isEditing) {
    return (
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
          data-test="message-edit-input"
        />
        <span className="text-xs text-default-500">
          <Trans
            t={t}
            i18nKey="escapeToCancel"
            components={{
              cancel: (
                <button
                  type="button"
                  onClick={onCancelEdit}
                  className="text-primary hover:underline"
                  data-test="message-edit-cancel"
                />
              ),
              save: (
                <button
                  type="button"
                  onClick={() => {
                    const trimmed = editContent.trim()
                    if (trimmed.length > 0) {
                      onSaveEdit(trimmed)
                    }
                  }}
                  className="text-primary hover:underline"
                  data-test="message-edit-save"
                />
              ),
            }}
          />
        </span>
      </div>
    )
  }

  if (isEncrypted && decryptMessage !== undefined && getCachedPlaintext !== undefined) {
    return (
      <div data-test="message-content">
        <EncryptedMessageContent
          message={message}
          decryptMessage={decryptMessage}
          getCachedPlaintext={getCachedPlaintext}
        />
        {message.editedAt !== undefined && message.editedAt !== null && (
          <span className="ml-1 text-xs text-default-400" data-test="message-edited-indicator">
            {t('edited')}
          </span>
        )}
      </div>
    )
  }

  // WHY: On web, encrypted messages from desktop users cannot be decrypted.
  // Show a user-friendly fallback instead of raw ciphertext.
  if (message.encrypted === true && !isTauri()) {
    return (
      <span
        className="inline-flex items-center gap-1.5 text-sm italic text-default-400"
        data-test="message-content"
      >
        <Lock className="h-3.5 w-3.5" />
        {tCrypto('encryptedWebFallback')}
      </span>
    )
  }

  return (
    <div data-test="message-content" className="text-sm text-foreground/90">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={{
          p: ({ children }) => <p className="mb-1 last:mb-0">{children}</p>,
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          code: ({ className, children }) => {
            const isBlock = className?.includes('language-')
            if (isBlock) {
              return (
                <code className="block rounded bg-default-100 p-2 font-mono text-sm">
                  {children}
                </code>
              )
            }
            return <code className="rounded bg-default-100 px-1 font-mono text-sm">{children}</code>
          },
          pre: ({ children }) => <pre className="my-1">{children}</pre>,
          blockquote: ({ children }) => (
            <blockquote className="border-l-3 border-default-300 pl-3 italic text-default-500">
              {children}
            </blockquote>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline"
            >
              {children}
            </a>
          ),
        }}
      >
        {message.content}
      </ReactMarkdown>
      {message.editedAt !== undefined && message.editedAt !== null && (
        <span className="ml-1 text-xs text-default-400" data-test="message-edited-indicator">
          {t('edited')}
        </span>
      )}
    </div>
  )
}

/**
 * WHY: System messages (join/leave announcements) have a distinct layout:
 * no avatar, no actions, centered text with an icon. The event key resolves
 * to a localized template via i18n.
 */
function SystemMessageItem({ message, t }: { message: MessageResponse; t: TFunction<'messages'> }) {
  const systemEventMap: Record<string, string> = {
    member_join: t('system.memberJoin', { username: message.authorUsername }),
    member_leave: t('system.memberLeave', { username: message.authorUsername }),
    member_kick: t('system.memberKick', { username: message.authorUsername }),
    member_ban: t('system.memberBan', { username: message.authorUsername }),
  }
  const text = systemEventMap[message.systemEventKey ?? ''] ?? t('system.unknown')

  return (
    <div
      data-test="message-item"
      data-test-system="true"
      data-message-id={message.id}
      className="flex items-center gap-2 px-4 py-1 text-sm text-default-500"
    >
      <ArrowRight className="h-4 w-4 shrink-0" />
      <span>{text}</span>
      <span className="text-xs text-default-400">{formatTimestamp(message.createdAt, t)}</span>
    </div>
  )
}

// WHY extracted: Reduces MessageItem cognitive complexity below Biome's limit of 15.
function ParentQuote({ parentMessage }: { parentMessage?: MessageResponse['parentMessage'] }) {
  if (parentMessage === undefined || parentMessage === null) return null

  return (
    <div className="mb-1 border-l-2 border-default-300 pl-2 opacity-75">
      <span className="text-xs font-medium">{parentMessage.authorUsername}</span>
      <p className="truncate text-xs text-default-500">{parentMessage.contentPreview}</p>
    </div>
  )
}

// WHY extracted: Reduces MessageItem cognitive complexity below Biome's limit of 15.
function ReactionBar({
  reactions,
  isDeleted,
  onAddReaction,
  onRemoveReaction,
}: {
  reactions: MessageResponse['reactions']
  isDeleted: boolean
  onAddReaction?: (emoji: string) => void
  onRemoveReaction?: (emoji: string) => void
}) {
  if (reactions === undefined || reactions.length === 0 || isDeleted) return null

  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {reactions.map((r) => (
        <button
          key={r.emoji}
          type="button"
          onClick={() =>
            r.reactedByMe === true ? onRemoveReaction?.(r.emoji) : onAddReaction?.(r.emoji)
          }
          className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors${r.reactedByMe === true ? ' border-primary bg-primary/10 text-primary' : ' border-default-200 bg-default-50 hover:bg-default-100'}`}
        >
          <span>{r.emoji}</span>
          <span>{r.count}</span>
        </button>
      ))}
    </div>
  )
}

// WHY extracted: Reduces MessageItem cognitive complexity below Biome's limit of 15.
function MessageHeader({
  authorLabel,
  isPending,
  message,
  isDm,
}: {
  authorLabel: string
  isPending: boolean
  message: MessageResponse
  isDm: boolean
}) {
  const { t } = useTranslation('messages')
  const { t: tCrypto } = useTranslation('crypto')

  return (
    <div className="flex items-baseline gap-2">
      <span
        data-test="message-author"
        className="cursor-pointer font-medium text-foreground hover:underline"
      >
        {authorLabel}
      </span>
      <span data-test="message-timestamp" className="text-xs text-default-500">
        {isPending ? t('sending') : formatTimestamp(message.createdAt, t)}
      </span>
      {isDm && (
        <Tooltip
          content={
            message.encrypted === true
              ? tCrypto('encryptedTooltip')
              : tCrypto('notEncryptedTooltip')
          }
          size="sm"
        >
          <span data-test="message-encryption-indicator" className="inline-flex items-center">
            {message.encrypted === true ? (
              <Lock className="h-3 w-3 text-success-500" />
            ) : (
              <LockOpen className="h-3 w-3 text-default-400" />
            )}
          </span>
        </Tooltip>
      )}
    </div>
  )
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
  canModerateMessages,
  isEditing,
  isGrouped = false,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onDelete,
  onAddReaction,
  onRemoveReaction,
  onReply,
  isDm = false,
  isChannelEncrypted = false,
  decryptMessage,
  decryptChannelMessage,
  getCachedPlaintext,
}: MessageItemProps) {
  const { t } = useTranslation('messages')
  // WHY: useState must be called before any conditional returns (React rules of hooks).
  const [editContent, setEditContent] = useState(message.content)

  // WHY: System messages have a completely different layout — early return.
  if (message.messageType === 'system') {
    return <SystemMessageItem message={message} t={t} />
  }

  const authorLabel = message.authorUsername

  // WHY derive from ID: Optimistic messages use `temp-*` IDs. Deriving pending
  // state from the ID avoids an extra prop and stays in sync automatically —
  // when the real message replaces the optimistic one, the ID changes and
  // pending styling disappears without any manual state management.
  const isPending = message.id.startsWith('temp-')

  const isOwnMessage = message.authorId === currentUserId
  const isDeleted = message.deletedBy !== undefined && message.deletedBy !== null
  const isModeratorDeleted = isDeleted && message.deletedBy !== message.authorId
  // WHY: Message is encrypted if it's a DM with encrypted flag, or in an encrypted channel.
  const isEncrypted = message.encrypted === true && (isDm || isChannelEncrypted)
  // WHY: Use channel decryption for encrypted channels, Olm decryption for DMs.
  const activeDecryptFn = isChannelEncrypted ? decryptChannelMessage : decryptMessage

  return (
    <div
      data-test="message-item"
      data-message-id={message.id}
      className={`group relative flex gap-4 px-4 hover:bg-default-200/50${isPending ? ' opacity-60' : ''}${isGrouped ? ' py-0.5' : ' py-1'}`}
    >
      {isGrouped ? (
        <div className="w-10 shrink-0" />
      ) : (
        <Avatar
          name={authorLabel}
          color="primary"
          size="md"
          classNames={{
            base: 'mt-0.5 h-10 w-10 shrink-0',
            name: 'text-sm',
          }}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        {!isGrouped && (
          <MessageHeader
            authorLabel={authorLabel}
            isPending={isPending}
            message={message}
            isDm={isDm}
          />
        )}

        <ParentQuote parentMessage={message.parentMessage} />

        <MessageContent
          message={message}
          isEncrypted={isEncrypted}
          isDeleted={isDeleted}
          isModeratorDeleted={isModeratorDeleted}
          isEditing={isEditing}
          editContent={editContent}
          setEditContent={setEditContent}
          onSaveEdit={onSaveEdit}
          onCancelEdit={onCancelEdit}
          decryptMessage={activeDecryptFn}
          getCachedPlaintext={getCachedPlaintext}
        />

        <ReactionBar
          reactions={message.reactions}
          isDeleted={isDeleted}
          onAddReaction={onAddReaction}
          onRemoveReaction={onRemoveReaction}
        />
      </div>

      {/* WHY: Actions bar shows for non-deleted, non-pending messages.
          Reply is available to everyone. Edit is own-message-only.
          Delete shows for own messages OR if moderator+. */}
      {isEditing === false && isPending === false && isDeleted === false && (
        <div
          data-test="message-actions"
          className="absolute -top-3 right-4 hidden gap-0.5 rounded-md border border-divider bg-background shadow-sm group-hover:flex"
        >
          {onReply !== undefined && (
            <Button
              variant="light"
              isIconOnly
              size="sm"
              onPress={onReply}
              data-test="message-reply-button"
            >
              <MessageSquare className="h-4 w-4 text-default-500" />
            </Button>
          )}
          {isOwnMessage && (
            <Button
              variant="light"
              isIconOnly
              size="sm"
              onPress={onStartEdit}
              data-test="message-edit-button"
            >
              <Pencil className="h-4 w-4 text-default-500" />
            </Button>
          )}
          {(isOwnMessage || canModerateMessages) && (
            <Button
              variant="light"
              isIconOnly
              size="sm"
              onPress={onDelete}
              data-test="message-delete-button"
            >
              <Trash2 className="h-4 w-4 text-danger" />
            </Button>
          )}
        </div>
      )}
    </div>
  )
})
