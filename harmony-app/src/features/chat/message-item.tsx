import { Avatar, Button, Textarea, Tooltip } from '@heroui/react'
import type { TFunction } from 'i18next'
import { Lock, LockOpen, Pencil, Trash2 } from 'lucide-react'
import { memo, useRef, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
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
  onStartEdit: () => void
  onSaveEdit: (content: string) => void
  onCancelEdit: () => void
  onDelete: () => void
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
      <span className="inline-flex items-center gap-1.5 text-sm italic text-default-400" data-test="message-content">
        <Lock className="h-3.5 w-3.5" />
        {tCrypto('encryptedWebFallback')}
      </span>
    )
  }

  return (
    <p data-test="message-content" className="text-sm text-foreground/90">
      {message.content}
      {message.editedAt !== undefined && message.editedAt !== null && (
        <span className="ml-1 text-xs text-default-400" data-test="message-edited-indicator">
          {t('edited')}
        </span>
      )}
    </p>
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
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onDelete,
  isDm = false,
  isChannelEncrypted = false,
  decryptMessage,
  decryptChannelMessage,
  getCachedPlaintext,
}: MessageItemProps) {
  const { t } = useTranslation('messages')
  const { t: tCrypto } = useTranslation('crypto')
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

  const [editContent, setEditContent] = useState(message.content)

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
      </div>

      {/* WHY: Edit is own-message-only. Delete shows for own messages OR
          if the current user is moderator+ (canModerateMessages).
          Actions are hidden for deleted messages (tombstones). */}
      {(isOwnMessage || canModerateMessages) &&
        isEditing === false &&
        isPending === false &&
        isDeleted === false && (
          <div
            data-test="message-actions"
            className="absolute -top-3 right-4 hidden gap-0.5 rounded-md border border-divider bg-background shadow-sm group-hover:flex"
          >
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
            <Button
              variant="light"
              isIconOnly
              size="sm"
              onPress={onDelete}
              data-test="message-delete-button"
            >
              <Trash2 className="h-4 w-4 text-danger" />
            </Button>
          </div>
        )}
    </div>
  )
})
