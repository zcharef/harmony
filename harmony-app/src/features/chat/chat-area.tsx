import {
  Avatar,
  Button,
  Divider,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Spinner,
  Textarea,
} from '@heroui/react'
import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual'
import {
  Bell,
  ChevronDown,
  ChevronUp,
  Film,
  Hash,
  MessageCircle,
  MessageSquare,
  Pin,
  PlusCircle,
  Search,
  ShieldCheck,
  SmilePlus,
  Sticker,
  Users,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ErrorState } from '@/components/shared/error-state'
import { useAuthStore, useCurrentProfile } from '@/features/auth'
import { useMarkRead, useUnreadStore } from '@/features/channels'
import {
  DmPlaintextBanner,
  E2eeAlphaBanner,
  EncryptedChannelNotice,
  EncryptionRequiredBanner,
  TrustBadge,
  useChannelEncryption,
  useCryptoSession,
  useCryptoStore,
  useEncryptedMessages,
  useSafetyNumber,
  useTrustLevel,
  VerifyIdentityModal,
} from '@/features/crypto'
import { type MemberRole, ROLE_HIERARCHY } from '@/features/members'
import { useChannelNotificationLevel } from '@/features/notifications'
import { StatusIndicator, useUserStatus } from '@/features/presence'
import type { DmRecipientResponse, MessageResponse } from '@/lib/api'
import { getApiErrorDetail } from '@/lib/api-error'
import { encrypt } from '@/lib/crypto'
import { cacheMessage } from '@/lib/crypto-cache'
import { resolveDisplayName } from '@/lib/display-name'
import { logger } from '@/lib/logger'
import { isTauri } from '@/lib/platform'
import { AttachmentTray } from './components/attachment-tray'
import { MentionAutocomplete, mentionOptionId } from './components/mention-autocomplete'
import { EmojiPickerPopover } from './emoji-picker-popover'
import { GifPickerPopover } from './gif-picker-popover'
import { useAddReaction } from './hooks/use-add-reaction'
import { useChannelReadState } from './hooks/use-channel-read-state'
import { type ComposerAttachments, useComposerAttachments } from './hooks/use-composer-attachments'
import { useDeleteMessage } from './hooks/use-delete-message'
import { useEditMessage } from './hooks/use-edit-message'
import { useGifCapability } from './hooks/use-gif-capability'
import { useJumpToMessage } from './hooks/use-jump-to-message'
import type { UseMentionAutocompleteResult } from './hooks/use-mention-autocomplete'
import { useMentionAutocomplete } from './hooks/use-mention-autocomplete'
import { useMessages } from './hooks/use-messages'
import { useRealtimeMessages } from './hooks/use-realtime-messages'
import { useRealtimeReactions } from './hooks/use-realtime-reactions'
import { useRemoveReaction } from './hooks/use-remove-reaction'
import type { SendMessageEncryption } from './hooks/use-send-message'
import { OPTIMISTIC_ID_PREFIX, useSendMessage } from './hooks/use-send-message'
import { useSlowMode } from './hooks/use-slow-mode'
import { useTypingIndicator } from './hooks/use-typing-indicator'
import { useUpdateNotificationSettings } from './hooks/use-update-notification-settings'
import { ALLOWED_ATTACHMENT_TYPES, MAX_ATTACHMENTS_PER_MESSAGE } from './lib/attachment-file'
import { buildVirtualItems } from './lib/build-virtual-items'
import { applyMentionMap } from './lib/mention-tokens'
import { MessageItem } from './message-item'
import { useDividerStore } from './stores/divider-store'
import { TypingIndicator } from './typing-indicator'

interface ChatAreaProps {
  channelId: string | null
  channelName: string | null
  /** WHY: Server context for the mention pill's members-cache fallback (spec §5.3). */
  serverId?: string | null
  currentUserRole: MemberRole
  /** WHY: When true, renders a DM-style header (avatar + name) instead of # channel-name */
  isDm?: boolean
  /** WHY: Recipient info for DM header display. Only used when isDm is true. */
  dmRecipient?: DmRecipientResponse | null
  /** WHY: When true and user role < admin, the message input is disabled. */
  isReadOnly?: boolean
  /** WHY: When true, messages are Megolm-encrypted. Derived from channel.encrypted in parent. */
  isChannelEncrypted?: boolean
  /** WHY: Minimum seconds between messages per user. 0 = disabled. Drives useSlowMode hook. */
  slowModeSeconds?: number
}

/**
 * WHY deduplication here: Two cache update paths exist — realtime INSERT and
 * sendMessage mutation invalidation. They can race, producing duplicate messages
 * in the page cache. Deduplicating at the flatten step is the safest approach
 * since it handles all race conditions regardless of source.
 */

// WHY extracted: Reduces ChatArea cognitive complexity below Biome's limit of 15.
function ReplyBar({
  replyingTo,
  onCancel,
}: {
  replyingTo: MessageResponse | null
  onCancel: () => void
}) {
  const { t } = useTranslation('chat')

  if (replyingTo === null) return null

  return (
    <div className="flex items-center justify-between border-t border-default-200 bg-default-100 px-4 py-2">
      <div className="min-w-0">
        <span className="text-xs text-default-500">{t('replyingTo')} </span>
        <span className="text-xs font-medium">{replyingTo.authorUsername}</span>
        <p className="truncate text-xs text-default-400">{replyingTo.content.slice(0, 80)}</p>
      </div>
      <Button isIconOnly size="sm" variant="light" onPress={onCancel}>
        <X className="h-4 w-4" />
      </Button>
    </div>
  )
}

// WHY extracted: Reduces ChatArea cognitive complexity below Biome's limit of 15.
function useMarkReadOnFocus(channelId: string | null, messages: MessageResponse[]) {
  const markReadMutation = useMarkRead()
  const clearUnread = useUnreadStore((s) => s.clear)
  // WHY: Skip temp-* optimistic IDs — they fail UUID validation on the server (422).
  let lastMessageId: string | undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!messages[i]?.id.startsWith(OPTIMISTIC_ID_PREFIX)) {
      lastMessageId = messages[i]?.id
      break
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally stable — only re-run on channel switch or first message load
  useEffect(() => {
    if (channelId === null || lastMessageId === undefined) return
    clearUnread(channelId)
    markReadMutation.mutate({ channelId, lastMessageId })
  }, [channelId, lastMessageId])
}

function useFlatMessages(data: ReturnType<typeof useMessages>['data']) {
  return useMemo(() => {
    if (!data) return []
    const seen = new Set<string>()
    const deduped: MessageResponse[] = []
    // WHY: API returns DESC (newest first per page). Flatten then reverse for oldest-first display.
    const allMessages = data.pages.flatMap((page) => page.items)
    for (const msg of allMessages) {
      if (!seen.has(msg.id)) {
        seen.add(msg.id)
        deduped.push(msg)
      }
    }
    return deduped.reverse()
  }, [data])
}

// WHY extracted: Reduces ChatArea cognitive complexity below Biome's limit of 15.
function useAutoScroll(
  scrollRef: React.RefObject<HTMLDivElement | null>,
  messageCount: number,
  channelId: string | null,
  virtualizer: Virtualizer<HTMLDivElement, Element>,
  isTypingVisible: boolean,
) {
  const prevMessageCountRef = useRef(0)
  const prevChannelIdRef = useRef(channelId)

  useEffect(() => {
    if (prevChannelIdRef.current !== channelId) {
      prevChannelIdRef.current = channelId
      prevMessageCountRef.current = 0
    }

    const prevCount = prevMessageCountRef.current

    if (messageCount > 0 && prevCount === 0) {
      virtualizer.scrollToIndex(messageCount - 1, { align: 'end' })
    } else if (messageCount > prevCount && prevCount > 0) {
      const el = scrollRef.current
      if (el) {
        const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
        if (distanceFromBottom < 200) {
          virtualizer.scrollToIndex(messageCount - 1, { align: 'end' })
        }
      }
    }

    prevMessageCountRef.current = messageCount
  }, [messageCount, channelId, virtualizer, scrollRef])

  // WHY: When the typing indicator appears or disappears, the scroll container
  // resizes (flex-1 gains/loses ~24px). The browser preserves scrollTop, so the
  // visible bottom edge shifts — hiding the last message. Re-anchor to bottom
  // if the user was already near the bottom.
  // biome-ignore lint/correctness/useExhaustiveDependencies: isTypingVisible is a trigger-only dep — not read inside, but the effect must run when it changes
  useEffect(() => {
    if (messageCount === 0) return
    const el = scrollRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distanceFromBottom < 200) {
      virtualizer.scrollToIndex(messageCount - 1, { align: 'end' })
    }
  }, [isTypingVisible, messageCount, virtualizer, scrollRef])
}

function useThrottledScroll(
  scrollRef: React.RefObject<HTMLDivElement | null>,
  hasNextPage: boolean | undefined,
  isFetchingNextPage: boolean,
  fetchNextPage: () => void,
) {
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  return useCallback(() => {
    if (scrollTimerRef.current !== null) return
    scrollTimerRef.current = setTimeout(() => {
      scrollTimerRef.current = null
      const el = scrollRef.current
      if (!el) return
      if (el.scrollTop < 200 && hasNextPage === true && isFetchingNextPage === false) {
        fetchNextPage()
      }
    }, 100)
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, scrollRef])
}

/**
 * WHY: Combines Supabase Auth user ID (available immediately) with the DB
 * profile username (SSoT via GET /v1/profiles/me). Falls back to i18n
 * 'unknownUser' while the profile is loading.
 */
function useCurrentUser() {
  const { t } = useTranslation('chat')
  const user = useAuthStore((s) => s.user)
  const { data: profile } = useCurrentProfile()
  const id = user?.id ?? ''
  const username = profile?.username ?? t('unknownUser')
  return { id, username }
}

// WHY extracted: Keeps ChatArea below Biome's cognitive complexity limit of 15.
function useMessageActions(
  channelId: string | null,
  currentUserId: string,
  currentUsername: string,
  encryption?: SendMessageEncryption,
  onRateLimited?: (remainingSeconds: number) => void,
) {
  const safeChannelId = channelId ?? ''
  const sendMessage = useSendMessage(
    safeChannelId,
    currentUserId,
    currentUsername,
    encryption,
    onRateLimited,
  )
  const editMessageMutation = useEditMessage(safeChannelId)
  const deleteMessageMutation = useDeleteMessage(safeChannelId, currentUserId)
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)

  const handleStartEdit = useCallback((messageId: string) => {
    setEditingMessageId(messageId)
  }, [])

  const handleCancelEdit = useCallback(() => {
    setEditingMessageId(null)
  }, [])

  const handleSaveEdit = useCallback(
    (messageId: string, content: string) => {
      editMessageMutation.mutate(
        { messageId, content },
        { onSuccess: () => setEditingMessageId(null) },
      )
    },
    [editMessageMutation],
  )

  const handleDelete = useCallback(
    (messageId: string) => {
      deleteMessageMutation.mutate(messageId)
    },
    [deleteMessageMutation],
  )

  return {
    sendMessage,
    editingMessageId,
    handleStartEdit,
    handleCancelEdit,
    handleSaveEdit,
    handleDelete,
  }
}

/**
 * WHY: Extracted header for DM conversations. Shows the recipient's avatar,
 * display name, online status, and verification controls (desktop only).
 */
function DmChatHeader({
  recipient,
  onOpenVerify,
}: {
  recipient: DmRecipientResponse
  onOpenVerify: () => void
}) {
  const displayName = resolveDisplayName(recipient)
  const status = useUserStatus(recipient.id)
  const { t } = useTranslation('crypto')
  const { trustLevel } = useTrustLevel(isTauri() ? recipient.id : null)

  return (
    <div className="flex items-center gap-2">
      <div className="relative">
        <Avatar
          name={displayName}
          src={recipient.avatarUrl ?? undefined}
          size="sm"
          showFallback
          classNames={{ base: 'h-7 w-7', name: 'text-[10px]' }}
        />
        <div className="absolute -bottom-0.5 -right-0.5">
          <StatusIndicator status={status} size="sm" />
        </div>
      </div>
      <span className="font-semibold text-foreground">{displayName}</span>
      {isTauri() && <TrustBadge trustLevel={trustLevel} />}
      {isTauri() && <E2eeAlphaBanner />}
      {isTauri() && (
        <Button
          variant="light"
          isIconOnly
          size="sm"
          onPress={onOpenVerify}
          aria-label={t('verifyIdentity')}
          data-test="verify-identity-button"
        >
          <ShieldCheck className="h-4 w-4 text-default-500" />
        </Button>
      )}
    </div>
  )
}

// WHY: Extracted to reduce ChatArea cognitive complexity below Biome's limit of 15.
function ChatToolbar({
  isDm,
  dmRecipient,
  channelName,
  channelId,
  isChannelEncrypted,
  onOpenVerify,
}: {
  isDm: boolean
  dmRecipient: DmRecipientResponse | null
  channelName: string | null
  channelId: string | null
  isChannelEncrypted: boolean
  onOpenVerify: () => void
}) {
  const { t } = useTranslation('chat')
  const notifLevel = useChannelNotificationLevel(channelId)
  const updateNotif = useUpdateNotificationSettings(channelId ?? '')
  // WHY no 'mentions' for DMs (D14): every DM message is mention-equivalent —
  // Discord DMs only offer mute. Stale 'mentions' rows on DM channels behave
  // as 'all' by policy construction.
  const levelOptions = isDm ? (['all', 'none'] as const) : (['all', 'mentions', 'none'] as const)

  return (
    <div
      data-test="chat-toolbar"
      className="flex h-12 items-center justify-between border-b border-divider px-4 shadow-sm"
    >
      {isDm && dmRecipient !== null ? (
        <DmChatHeader recipient={dmRecipient} onOpenVerify={onOpenVerify} />
      ) : (
        <div className="flex items-center gap-2">
          <Hash className="h-5 w-5 text-default-500" />
          <span className="font-semibold text-foreground">
            {channelName ?? t('channelFallback')}
          </span>
          {isChannelEncrypted && <E2eeAlphaBanner />}
        </div>
      )}
      <div className="flex items-center gap-1">
        <Button variant="light" isIconOnly size="sm" aria-label={t('threads')}>
          <MessageSquare className="h-5 w-5 text-default-500" />
        </Button>
        <Popover placement="bottom-end">
          <PopoverTrigger>
            <Button variant="light" isIconOnly size="sm" aria-label={t('notifications')}>
              <Bell className="h-5 w-5 text-default-500" />
            </Button>
          </PopoverTrigger>
          <PopoverContent>
            <div className="flex flex-col gap-1 p-2">
              {levelOptions.map((level) => (
                <Button
                  key={level}
                  variant={notifLevel === level ? 'flat' : 'light'}
                  size="sm"
                  onPress={() => updateNotif.mutate(level)}
                >
                  {t(`notificationLevel.${level}`)}
                </Button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
        <Button variant="light" isIconOnly size="sm" aria-label={t('pinnedMessages')}>
          <Pin className="h-5 w-5 text-default-500" />
        </Button>
        {!isDm && (
          <Button variant="light" isIconOnly size="sm" aria-label={t('memberList')}>
            <Users className="h-5 w-5 text-default-500" />
          </Button>
        )}
        <div className="ml-2 flex h-6 items-center rounded bg-default-100 px-1.5">
          <Search className="h-4 w-4 text-default-500" />
          <span className="ml-1 text-xs text-default-500">{t('common:search')}</span>
        </div>
      </div>
    </div>
  )
}

function DateDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-4 px-4 py-2">
      <Divider className="flex-1" />
      <span className="text-xs font-semibold text-default-500">{label}</span>
      <Divider className="flex-1" />
    </div>
  )
}

// WHY danger token only (HeroUI/ADR-044): the red "new messages" separator uses
// the semantic `danger` color, no hardcoded red and no dark: overrides.
function NewMessagesDivider() {
  const { t } = useTranslation('chat')
  // WHY no explicit role: HeroUI <Divider> already renders role="separator"; the
  // visible "New messages" label carries the meaning to screen readers.
  return (
    <div data-test="new-messages-divider" className="flex items-center gap-2 px-4 py-1">
      <Divider className="flex-1 bg-danger" />
      <span className="font-semibold text-[10px] text-danger uppercase tracking-wide">
        {t('newMessages')}
      </span>
    </div>
  )
}

// WHY extracted: Keeps ChatArea below Biome's cognitive complexity limit of 15.
/** Maps the composer's inline attachment error state to a localized string. */
function useAttachmentInlineError(attachments: ComposerAttachments): string | null {
  const { t } = useTranslation('chat')
  if (attachments.sendError !== null) return attachments.sendError
  switch (attachments.capError) {
    case 'tooMany':
      return t('attachTooMany', { max: MAX_ATTACHMENTS_PER_MESSAGE })
    case 'tooLarge':
      return t('attachTooLarge')
    case 'unsupported':
      return t('attachUnsupported')
    default:
      return null
  }
}

function MessageInput({
  isInputDisabled,
  placeholder,
  value,
  onValueChange,
  onKeyDown,
  onSendTyping,
  onGifSelect,
  mention,
  textareaRef,
  attachments,
  attachmentsEnabled,
}: {
  isInputDisabled: boolean
  placeholder: string
  value: string
  onValueChange: (value: string) => void
  onKeyDown: (e: React.KeyboardEvent) => void
  onSendTyping: () => void
  /** WHY: a picked GIF sends immediately as its own message (Discord behavior). */
  onGifSelect: (gifUrl: string) => void
  /** WHY: state lives in ChatArea (useMentionAutocomplete) — the send transform needs its map. */
  mention: UseMentionAutocompleteResult
  /** WHY lifted: the autocomplete hook reads the caret from this node. */
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  /** Pending-attachment tray state (spec §5.2). */
  attachments: ComposerAttachments
  /** WHY a flag (not just isInputDisabled): attach UI is hidden in encrypted contexts (D7). */
  attachmentsEnabled: boolean
}) {
  const { t } = useTranslation('chat')
  const [isEmojiOpen, setIsEmojiOpen] = useState(false)
  const [isDragActive, setIsDragActive] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isGifOpen, setIsGifOpen] = useState(false)
  // WHY: hide the GIF button when the deployment has no Klipy key (proxy 503),
  // so self-hosters never see a dead button.
  const isGifEnabled = useGifCapability()
  const highlightedCandidate = mention.results[mention.highlightIndex]
  const inlineError = useAttachmentInlineError(attachments)

  // WHY canAttach gate: paste/drop/picker all vanish exactly when send does
  // (read-only / no-permission → isInputDisabled) and in encrypted contexts.
  const canAttach = attachmentsEnabled && !isInputDisabled
  const { enqueueFiles } = attachments

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      if (!canAttach) return
      // WHY not preventDefault unconditionally: a text paste must still paste
      // text — only a file/image paste is intercepted (Discord parity, §6.3).
      if (e.clipboardData.files.length > 0) {
        e.preventDefault()
        enqueueFiles(e.clipboardData.files)
      }
    },
    [canAttach, enqueueFiles],
  )

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!canAttach) return
      e.preventDefault()
      setIsDragActive(true)
    },
    [canAttach],
  )

  const handleDragLeave = useCallback(
    (e: React.DragEvent) => {
      if (!canAttach) return
      e.preventDefault()
      // WHY relatedTarget check: dragleave also fires when the cursor crosses
      // onto a child (textarea, buttons) — only clear when the drag truly left
      // the composer, otherwise the overlay flickers.
      const related = e.relatedTarget
      if (related instanceof Node && e.currentTarget.contains(related)) return
      setIsDragActive(false)
    },
    [canAttach],
  )

  // WHY reset on gate close: if canAttach flips false mid-drag (channel switch
  // to an encrypted context), the drop handlers detach and no dragleave fires —
  // clear the overlay so it can't get stuck visible.
  useEffect(() => {
    if (!canAttach) setIsDragActive(false)
  }, [canAttach])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      if (!canAttach) return
      e.preventDefault()
      setIsDragActive(false)
      if (e.dataTransfer.files.length > 0) enqueueFiles(e.dataTransfer.files)
    },
    [canAttach, enqueueFiles],
  )

  const handlePick = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files
      if (files !== null && files.length > 0) enqueueFiles(files)
      // WHY reset: re-picking the same file must fire onChange again.
      e.target.value = ''
    },
    [enqueueFiles],
  )

  const handleEmojiSelect = useCallback(
    (emoji: string) => {
      const textarea = textareaRef.current
      if (textarea) {
        const start = textarea.selectionStart
        const end = textarea.selectionEnd
        const next = value.slice(0, start) + emoji + value.slice(end)
        onValueChange(next)
      } else {
        onValueChange(value + emoji)
      }
    },
    [value, onValueChange, textareaRef],
  )

  return (
    <div className="px-4 pb-6 pt-1">
      {canAttach && (
        <AttachmentTray items={attachments.items} onRemove={attachments.removeAttachment} />
      )}
      {inlineError !== null && (
        <p role="alert" data-test="attachment-error" className="mb-1 px-1 text-xs text-danger">
          {inlineError}
        </p>
      )}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: drop-zone wraps the composer; keyboard users attach via the picker button. */}
      <div
        className="relative flex items-center rounded-lg bg-default-100"
        onDragOver={canAttach ? handleDragOver : undefined}
        onDragLeave={canAttach ? handleDragLeave : undefined}
        onDrop={canAttach ? handleDrop : undefined}
      >
        {isDragActive && (
          <div
            data-test="attachment-dropzone"
            aria-live="polite"
            className="absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-primary bg-primary-50/90 text-sm font-medium text-primary"
          >
            {t('dropToAttach')}
          </div>
        )}
        <MentionAutocomplete
          isOpen={mention.isOpen}
          isLoading={mention.isLoading}
          results={mention.results}
          highlightIndex={mention.highlightIndex}
          onSelect={mention.insertMention}
          onClose={mention.close}
        />
        {canAttach && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              // WHY derive from the allowlist: the OS picker and the client
              // validator agree, so a picked file is never rejected as
              // "unsupported" right after the user chose it.
              accept={ALLOWED_ATTACHMENT_TYPES.join(',')}
              className="hidden"
              data-test="attachment-file-input"
              onChange={handlePick}
            />
            <Button
              variant="light"
              isIconOnly
              size="sm"
              className="ml-1 shrink-0"
              aria-label={t('attachFile')}
              data-test="attachment-picker"
              onPress={() => fileInputRef.current?.click()}
            >
              <PlusCircle className="h-5 w-5 text-default-500" />
            </Button>
          </>
        )}
        <Textarea
          ref={textareaRef}
          data-test="message-input"
          placeholder={placeholder}
          variant="flat"
          minRows={1}
          maxRows={6}
          isReadOnly={isInputDisabled}
          value={value}
          onValueChange={(v) => {
            if (isInputDisabled) return
            onValueChange(v)
            onSendTyping()
          }}
          onPaste={handlePaste}
          onKeyDown={isInputDisabled ? undefined : onKeyDown}
          aria-autocomplete="list"
          aria-expanded={mention.isOpen}
          aria-controls={mention.isOpen ? 'mention-listbox' : undefined}
          aria-activedescendant={
            mention.isOpen && highlightedCandidate !== undefined
              ? mentionOptionId(highlightedCandidate.userId)
              : undefined
          }
          classNames={{
            base: 'flex-1',
            inputWrapper:
              'border-0 bg-transparent shadow-none hover:!bg-transparent focus-within:!bg-transparent',
            input: 'text-sm text-foreground placeholder:text-default-500 px-2 py-3',
          }}
        />
        {!isInputDisabled && (
          <div className="flex shrink-0 items-center gap-0.5 pr-2">
            <Button variant="light" isIconOnly size="sm" aria-label={t('stickers')}>
              <Sticker className="h-5 w-5 text-default-500" />
            </Button>
            {isGifEnabled && (
              <GifPickerPopover
                isOpen={isGifOpen}
                onOpenChange={setIsGifOpen}
                onGifSelect={onGifSelect}
                placement="top-end"
              >
                <Button variant="light" isIconOnly size="sm" aria-label={t('gif.button')}>
                  <Film className="h-5 w-5 text-default-500" />
                </Button>
              </GifPickerPopover>
            )}
            <EmojiPickerPopover
              isOpen={isEmojiOpen}
              onOpenChange={setIsEmojiOpen}
              onEmojiSelect={handleEmojiSelect}
              placement="top-end"
            >
              <Button variant="light" isIconOnly size="sm" aria-label={t('emojiPicker')}>
                <SmilePlus className="h-5 w-5 text-default-500" />
              </Button>
            </EmojiPickerPopover>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * WHY: Extracted to reduce ChatArea cognitive complexity below Biome's limit of 15.
 * Renders the welcome/history-start section at the top of a conversation.
 */
function ChatWelcome({
  isDm,
  dmRecipient,
  channelName,
  subtitle,
}: {
  isDm: boolean
  dmRecipient: DmRecipientResponse | null
  channelName: string | null
  subtitle: string
}) {
  const { t } = useTranslation('chat')
  const { t: tDms } = useTranslation('dms')

  if (isDm && dmRecipient !== null) {
    const displayName = resolveDisplayName(dmRecipient)
    return (
      <>
        <Avatar
          name={displayName}
          src={dmRecipient.avatarUrl ?? undefined}
          showFallback
          classNames={{ base: 'h-16 w-16', name: 'text-lg' }}
        />
        <h2 className="mt-2 text-3xl font-bold text-foreground">{displayName}</h2>
        <p className="mt-1 text-sm text-default-500">{tDms('dmWelcome', { displayName })}</p>
      </>
    )
  }

  return (
    <>
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-default-100">
        <Hash className="h-10 w-10 text-default-500" />
      </div>
      <h2 className="mt-2 text-3xl font-bold text-foreground">
        {t('welcomeToChannel', { channelName: channelName ?? t('channelFallback') })}
      </h2>
      <p className="mt-1 text-sm text-default-500">{subtitle}</p>
    </>
  )
}

// WHY extracted: Keeps ChatArea below Biome's cognitive complexity limit of 15.
function useInputPlaceholder(
  isInputDisabled: boolean,
  isWebEncryptionBlocked: boolean,
  isDm: boolean,
  dmRecipient: DmRecipientResponse | null,
  channelName: string | null,
) {
  const { t } = useTranslation('chat')
  const { t: tDms } = useTranslation('dms')
  const { t: tCrypto } = useTranslation('crypto')

  if (isInputDisabled) {
    // WHY: Distinguish encrypted-channel-on-web from read-only announcement channels.
    if (isWebEncryptionBlocked) return tCrypto('encryptionDesktopOnly')
    return t('settings:announcementPlaceholder')
  }

  const dmDisplayName = dmRecipient !== null ? resolveDisplayName(dmRecipient) : null

  if (isDm && dmDisplayName !== null) {
    return tDms('dmChatPlaceholder', { username: dmDisplayName })
  }

  return t('messagePlaceholder', { channelName: channelName ?? t('channelFallback') })
}

/**
 * WHY extracted: Builds the E2EE encryption parameter for DM message sending.
 * Returns undefined when encryption is not applicable (not DM, not desktop, no session).
 * This keeps crypto concerns out of the main ChatArea rendering logic.
 */
function useDmEncryption(
  isDm: boolean,
  recipientUserId: string | null,
  /** WHY: Updates the in-memory decrypt cache so the sender can read their own message. */
  setCachedPlaintext?: (messageId: string, plaintext: string) => void,
): SendMessageEncryption | undefined {
  const { ensureSession } = useCryptoSession()
  const isDesktop = isTauri()
  const isInitialized = useCryptoStore((s) => s.isInitialized)
  const deviceId = useCryptoStore((s) => s.deviceId)

  return useMemo(() => {
    if (!isDm || !isDesktop || !isInitialized || recipientUserId === null || deviceId === null) {
      return undefined
    }

    return {
      encryptFn: async (plaintext: string) => {
        const { sessionId } = await ensureSession(recipientUserId)
        const encrypted = await encrypt(sessionId, plaintext)
        // WHY: Store as JSON envelope so the recipient can parse message_type + ciphertext.
        const content = JSON.stringify({
          message_type: encrypted.message_type,
          ciphertext: encrypted.ciphertext,
        })
        return { content, senderDeviceId: deviceId }
      },
      cachePlaintext: (messageId: string, channelId: string, plaintext: string) => {
        // WHY: Update in-memory cache so EncryptedMessageContent can display the
        // sender's own message immediately (sender can't decrypt their own Olm message).
        setCachedPlaintext?.(messageId, plaintext)
        cacheMessage(messageId, channelId, plaintext, new Date().toISOString()).catch(
          (err: unknown) => {
            logger.warn('cache_plaintext_failed', {
              messageId,
              error: err instanceof Error ? err.message : String(err),
            })
          },
        )
      },
    }
  }, [isDm, isDesktop, isInitialized, recipientUserId, deviceId, ensureSession, setCachedPlaintext])
}

/**
 * WHY extracted: Builds the E2EE encryption parameter for encrypted channel messages.
 * Returns undefined when encryption is not applicable (not encrypted, not desktop, no crypto).
 * Follows the same pattern as useDmEncryption above.
 */
function useChannelEncryptionParam(
  isChannelEncrypted: boolean,
  channelId: string | null,
  /** WHY: Updates the in-memory decrypt cache so the sender can read their own message. */
  setCachedPlaintext?: (messageId: string, plaintext: string) => void,
): SendMessageEncryption | undefined {
  const { encryptChannelMessage } = useChannelEncryption()
  const isDesktop = isTauri()
  const isInitialized = useCryptoStore((s) => s.isInitialized)
  const deviceId = useCryptoStore((s) => s.deviceId)

  return useMemo(() => {
    if (
      !isChannelEncrypted ||
      !isDesktop ||
      !isInitialized ||
      channelId === null ||
      deviceId === null
    ) {
      return undefined
    }

    return {
      encryptFn: async (plaintext: string) => {
        const result = await encryptChannelMessage(channelId, plaintext, deviceId)
        return { content: result.content, senderDeviceId: result.senderDeviceId }
      },
      cachePlaintext: (messageId: string, chId: string, plaintext: string) => {
        // WHY: Update in-memory cache so EncryptedMessageContent can display the
        // sender's own message immediately (same pattern as useDmEncryption).
        setCachedPlaintext?.(messageId, plaintext)
        cacheMessage(messageId, chId, plaintext, new Date().toISOString()).catch((err: unknown) => {
          logger.warn('cache_plaintext_failed', {
            messageId,
            error: err instanceof Error ? err.message : String(err),
          })
        })
      },
    }
  }, [
    isChannelEncrypted,
    isDesktop,
    isInitialized,
    channelId,
    deviceId,
    encryptChannelMessage,
    setCachedPlaintext,
  ])
}

/**
 * WHY extracted: Renders the blocked contact warning and message input area.
 * Reduces ChatArea cognitive complexity below Biome's limit of 15.
 */
function ChatInputSection({
  isBlocked,
  isInputDisabled,
  inputPlaceholder,
  messageContent,
  isDmInitFailed,
  slowModeRemainingSeconds,
  onValueChange,
  onKeyDown,
  onSendTyping,
  onGifSelect,
  mention,
  textareaRef,
  attachments,
  attachmentsEnabled,
}: {
  isBlocked: boolean
  isInputDisabled: boolean
  inputPlaceholder: string
  messageContent: string
  /** WHY: When true, E2EE init failed and this is a DM — warn that messages will be plaintext. */
  isDmInitFailed: boolean
  /** WHY: Shows countdown indicator above the input when > 0. Passed from useSlowMode. */
  slowModeRemainingSeconds: number
  onValueChange: (value: string) => void
  onKeyDown: (e: React.KeyboardEvent) => void
  onSendTyping: () => void
  onGifSelect: (gifUrl: string) => void
  mention: UseMentionAutocompleteResult
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  attachments: ComposerAttachments
  attachmentsEnabled: boolean
}) {
  const { t: tCrypto } = useTranslation('crypto')

  return (
    <>
      {isDmInitFailed && (
        <div className="px-4 py-2 text-center text-sm text-warning">
          {tCrypto('e2eeInitFailed')}
        </div>
      )}
      {isBlocked && (
        <div className="px-4 py-2 text-center text-sm text-danger">
          {tCrypto('blockedCannotSend')}
        </div>
      )}
      <SlowModeIndicator remainingSeconds={slowModeRemainingSeconds} />
      <MessageInput
        isInputDisabled={isInputDisabled}
        placeholder={isBlocked ? tCrypto('blockedCannotSend') : inputPlaceholder}
        value={messageContent}
        onValueChange={onValueChange}
        onKeyDown={onKeyDown}
        onSendTyping={onSendTyping}
        onGifSelect={onGifSelect}
        mention={mention}
        textareaRef={textareaRef}
        attachments={attachments}
        attachmentsEnabled={attachmentsEnabled}
      />
    </>
  )
}

/**
 * WHY extracted: Pre-warms decryption caches when entering encrypted channels/DMs.
 * Reduces ChatArea cognitive complexity below Biome's limit of 15.
 */
function useDecryptionCachePreload(
  isDm: boolean,
  isChannelEncrypted: boolean,
  channelId: string | null,
  loadCachedDecryptions: (channelId: string) => Promise<void>,
  loadCachedChannelDecryptions: (channelId: string) => Promise<void>,
) {
  useEffect(() => {
    if (channelId === null) return
    if (!isTauri()) return
    if (isDm) {
      loadCachedDecryptions(channelId)
    } else if (isChannelEncrypted) {
      loadCachedChannelDecryptions(channelId)
    }
  }, [isDm, isChannelEncrypted, channelId, loadCachedDecryptions, loadCachedChannelDecryptions])
}

/**
 * WHY extracted: Renders encryption banners for the chat welcome section.
 * Encrypted channels on web get the blocking EncryptionRequiredBanner.
 * DMs on web get the softer DmPlaintextBanner (web DMs work, just unencrypted).
 */
function EncryptionBannerSection({
  isDm,
  isChannelEncrypted,
}: {
  isDm: boolean
  isChannelEncrypted: boolean
}) {
  if (!isTauri() && isChannelEncrypted) {
    return (
      <div className="mt-4">
        <EncryptionRequiredBanner />
      </div>
    )
  }
  // WHY: DMs on web work (plaintext), but show a softer informational banner.
  if (!isTauri() && isDm) {
    return (
      <div className="mt-4">
        <DmPlaintextBanner />
      </div>
    )
  }
  return null
}

/**
 * WHY extracted: Renders loading/welcome/empty/error states for the message list.
 * Reduces ChatArea cognitive complexity below Biome's limit of 15.
 */
function MessageListStatus({
  isDm,
  isChannelEncrypted,
  channelId,
  channelName,
  dmRecipient,
  hasNextPage,
  isFetchingNextPage,
  isPending,
  isError,
  messageCount,
  onRetry,
  isRetrying,
}: {
  isDm: boolean
  isChannelEncrypted: boolean
  channelId: string
  channelName: string | null
  dmRecipient: DmRecipientResponse | null
  hasNextPage: boolean | undefined
  isFetchingNextPage: boolean
  isPending: boolean
  isError: boolean
  messageCount: number
  onRetry?: () => void
  isRetrying?: boolean
}) {
  const { t } = useTranslation('chat')

  return (
    <>
      {isFetchingNextPage && (
        <div className="flex justify-center py-2">
          <Spinner size="sm" />
        </div>
      )}

      {!hasNextPage && messageCount > 0 && (
        <div className="px-4 pb-6 pt-4">
          <ChatWelcome
            isDm={isDm}
            dmRecipient={dmRecipient}
            channelName={channelName}
            subtitle={t('channelStart', { channelName: channelName ?? t('channelFallback') })}
          />
          <EncryptionBannerSection isDm={isDm} isChannelEncrypted={isChannelEncrypted} />
          <Divider className="mt-4" />
        </div>
      )}

      {isChannelEncrypted && <EncryptedChannelNotice channelId={channelId} />}

      {isPending && (
        <div className="flex justify-center py-8">
          <Spinner size="md" />
        </div>
      )}

      {isError && messageCount === 0 && (
        <ErrorState
          icon={<Hash className="h-10 w-10" />}
          message={t('failedToLoadMessages')}
          onRetry={onRetry}
          isRetrying={isRetrying}
        />
      )}

      {messageCount === 0 && isPending === false && isError === false && (
        <div data-test="empty-state" className="px-4 pt-4">
          <ChatWelcome
            isDm={isDm}
            dmRecipient={dmRecipient}
            channelName={channelName}
            subtitle={t('noMessagesYet')}
          />
          <EncryptionBannerSection isDm={isDm} isChannelEncrypted={isChannelEncrypted} />
        </div>
      )}
    </>
  )
}

// WHY extracted: Reduces ChatArea cognitive complexity below Biome's limit of 15.
function ChatPlaceholder({ isDm }: { isDm: boolean }) {
  const { t } = useTranslation('chat')
  const PlaceholderIcon = isDm ? MessageCircle : Hash

  return (
    <div
      data-test="chat-placeholder"
      className="flex h-full flex-col items-center justify-center bg-background"
    >
      <PlaceholderIcon className="h-16 w-16 text-default-300" />
      <p className="mt-2 text-default-500">{t('selectChannel')}</p>
      <p className="mt-1 max-w-sm text-center text-sm text-default-400">{t('selectChannelHint')}</p>
    </div>
  )
}

// WHY extracted: Reduces ChatArea cognitive complexity below Biome's limit of 15.
function SlowModeIndicator({ remainingSeconds }: { remainingSeconds: number }) {
  const { t } = useTranslation('chat')

  if (remainingSeconds === 0) return null

  return (
    <div className="px-4 py-1 text-xs text-warning">
      {t('slowModeCooldown', { seconds: remainingSeconds })}
    </div>
  )
}

// WHY extracted: Derives input disabled/blocked state from multiple conditions.
// Reduces ChatArea cognitive complexity below Biome's limit of 15.
function useChatInputState(
  isDm: boolean,
  isChannelEncrypted: boolean,
  isReadOnly: boolean,
  currentUserRole: MemberRole,
  trustLevel: string,
  dmRecipient: DmRecipientResponse | null,
  channelName: string | null,
) {
  const isBlocked = isDm && isTauri() && trustLevel === 'blocked'
  const isWebEncryptionBlocked = !isTauri() && isChannelEncrypted
  const isInputDisabled =
    isBlocked ||
    isWebEncryptionBlocked ||
    (isReadOnly && ROLE_HIERARCHY[currentUserRole] < ROLE_HIERARCHY.admin)
  const initFailed = useCryptoStore((s) => s.initFailed)
  const isDmInitFailed = isDm && isTauri() && initFailed
  const inputPlaceholder = useInputPlaceholder(
    isInputDisabled && !isBlocked,
    isWebEncryptionBlocked,
    isDm,
    dmRecipient,
    channelName,
  )
  return { isBlocked, isInputDisabled, isDmInitFailed, inputPlaceholder }
}

export function ChatArea({
  channelId,
  channelName,
  serverId = null,
  currentUserRole,
  isDm = false,
  dmRecipient = null,
  isReadOnly = false,
  isChannelEncrypted = false,
  slowModeSeconds = 0,
}: ChatAreaProps) {
  const currentUser = useCurrentUser()

  const { decryptMessage, loadCachedDecryptions, getCachedPlaintext, setCachedPlaintext } =
    useEncryptedMessages()
  const {
    decryptChannelMessage,
    loadCachedChannelDecryptions,
    getCachedPlaintext: getChannelCachedPlaintext,
    setCachedPlaintext: setChannelCachedPlaintext,
  } = useChannelEncryption()

  // WHY: Build encryption param for DMs on desktop. Undefined for channels or web.
  const dmEncryption = useDmEncryption(isDm, dmRecipient?.id ?? null, setCachedPlaintext)
  // WHY: Build encryption param for encrypted channels on desktop.
  const channelEncryption = useChannelEncryptionParam(
    isChannelEncrypted,
    channelId,
    setChannelCachedPlaintext,
  )
  // WHY: Use channel encryption if available, else DM encryption, else undefined.
  const activeEncryption = channelEncryption ?? dmEncryption

  const {
    data,
    isPending,
    isError,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    refetch,
    isRefetching,
  } = useMessages(channelId)
  // WHY: useSlowMode must be called before useMessageActions so syncFromServer
  // can be passed as the onRateLimited callback for 429 handling.
  const isAdmin = ROLE_HIERARCHY[currentUserRole] >= ROLE_HIERARCHY.admin
  const { isInCooldown, remainingSeconds, startCooldown, syncFromServer } = useSlowMode(
    slowModeSeconds,
    isAdmin,
  )

  const {
    sendMessage,
    editingMessageId,
    handleStartEdit,
    handleCancelEdit,
    handleSaveEdit,
    handleDelete,
  } = useMessageActions(
    channelId,
    currentUser.id,
    currentUser.username,
    activeEncryption,
    syncFromServer,
  )
  const { t } = useTranslation('chat')
  const [messageContent, setMessageContent] = useState('')
  const [replyingTo, setReplyingTo] = useState<MessageResponse | null>(null)
  const [isVerifyOpen, setIsVerifyOpen] = useState(false)

  const attachments = useComposerAttachments()
  // WHY hide attach UI in encrypted contexts: v1 ships plaintext attachments
  // only; the API rejects attachments on encrypted messages (Decision D7).
  // `activeEncryption` is defined exactly when the send path encrypts.
  const attachmentsEnabled = activeEncryption === undefined

  // WHY reset on channel switch: ChatArea mounts once (no key={channelId} in
  // main-layout), so pending attachments outlive the channel they were staged
  // in. Without this they'd post to the wrong channel, or — switching into an
  // encrypted channel where the tray is gated off — sit invisible yet still be
  // forwarded to a send the API rejects, soft-locking the composer. clear()
  // also revokes the preview objectURLs.
  // biome-ignore lint/correctness/useExhaustiveDependencies: clear is stable; intentionally re-run only on channel switch
  useEffect(() => {
    attachments.clear()
  }, [channelId])

  // WHY here (not MessageInput): the send transform needs the mention map, and
  // the keyboard reducer must run BEFORE the Enter-to-send handler below.
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  const mention = useMentionAutocomplete({
    serverId,
    isDm,
    dmRecipient,
    value: messageContent,
    onValueChange: setMessageContent,
    textareaRef: composerRef,
  })

  // WHY: Safety number + trust level for DM identity verification (desktop only).
  const recipientIdForVerify = isDm && isTauri() ? (dmRecipient?.id ?? null) : null
  const { safetyNumber, isLoading: isLoadingSafetyNumber } = useSafetyNumber(recipientIdForVerify)
  const { trustLevel, setLevel: setTrustLevelFn } = useTrustLevel(recipientIdForVerify)

  useDecryptionCachePreload(
    isDm,
    isChannelEncrypted,
    channelId,
    loadCachedDecryptions,
    loadCachedChannelDecryptions,
  )

  useRealtimeMessages(channelId ?? '')
  useRealtimeReactions(channelId, currentUser.id)

  const addReactionMutation = useAddReaction(channelId ?? '')
  const removeReactionMutation = useRemoveReaction(channelId ?? '')

  const { typingUsers, sendTyping } = useTypingIndicator(channelId ?? '', currentUser.id)

  const messages = useFlatMessages(data)

  useMarkReadOnFocus(channelId, messages)

  // WHY: freeze the "new messages" divider boundary ONCE on channel open. The
  // read-state query snapshots lastReadAt (staleTime: Infinity), and the store
  // holds it frozen so the concurrent mark-read doesn't erase the divider (§5.6).
  const { data: readState } = useChannelReadState(channelId)
  const freezeDivider = useDividerStore((s) => s.freeze)
  const clearDivider = useDividerStore((s) => s.clear)
  useEffect(() => {
    if (channelId !== null && readState !== undefined) {
      freezeDivider(channelId, readState.lastReadAt ?? null)
    }
  }, [channelId, readState, freezeDivider])

  const isDividerFrozen = useDividerStore(
    (s) => channelId !== null && s.anchors[channelId] !== undefined,
  )
  const dividerAnchorAt = useDividerStore((s) =>
    channelId === null ? null : (s.anchors[channelId]?.anchorAt ?? null),
  )

  // WHY clear on channel switch: re-entry must re-freeze a fresh boundary below
  // where the user left off (mirrors the prevChannelIdRef pattern in useAutoScroll).
  const prevDividerChannelRef = useRef(channelId)
  useEffect(() => {
    const prev = prevDividerChannelRef.current
    if (prev !== channelId && prev !== null) clearDivider(prev)
    prevDividerChannelRef.current = channelId
  }, [channelId, clearDivider])

  // §6.2: when the whole loaded window is newer than the boundary AND more
  // history exists, the real first-unread is above the window — suppress the
  // inline divider and let the jump-to-unread pill fetch it on demand.
  const boundaryAboveWindow = useMemo(() => {
    if (!isDividerFrozen || dividerAnchorAt === null) return false
    const oldest = messages[0]
    if (oldest === undefined || hasNextPage !== true) return false
    return new Date(oldest.createdAt).getTime() > new Date(dividerAnchorAt).getTime()
  }, [isDividerFrozen, dividerAnchorAt, messages, hasNextPage])

  const virtualItems = useMemo(
    () =>
      buildVirtualItems(
        messages,
        isDividerFrozen && !boundaryAboveWindow
          ? { dividerAnchorAt, currentUserId: currentUser.id }
          : null,
      ),
    [messages, isDividerFrozen, boundaryAboveWindow, dividerAnchorAt, currentUser.id],
  )
  const scrollRef = useRef<HTMLDivElement>(null)

  const virtualizer = useVirtualizer({
    count: virtualItems.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const type = virtualItems[index]?.type
      return type === 'date' || type === 'new-messages' ? 36 : 56
    },
    overscan: 10,
  })

  useAutoScroll(scrollRef, virtualItems.length, channelId, virtualizer, typingUsers.length > 0)

  const { jumpToMessage, flashMessageId } = useJumpToMessage({
    channelId,
    virtualItems,
    virtualizer,
  })

  const dividerIndex = useMemo(
    () => virtualItems.findIndex((item) => item.type === 'new-messages'),
    [virtualItems],
  )

  // WHY scroll-driven state: the jump pills depend on the current viewport
  // (divider above the top edge / far from the bottom). A tiny state bump on
  // scroll keeps them reactive without measuring on every render.
  const [pillView, setPillView] = useState({ firstIndex: 0, distanceFromBottom: 0 })
  const updatePillView = useCallback(() => {
    const el = scrollRef.current
    const firstIndex = virtualizer.getVirtualItems()[0]?.index ?? 0
    const distanceFromBottom = el ? el.scrollHeight - el.scrollTop - el.clientHeight : 0
    setPillView((prev) =>
      prev.firstIndex === firstIndex && prev.distanceFromBottom === distanceFromBottom
        ? prev
        : { firstIndex, distanceFromBottom },
    )
  }, [virtualizer])

  useEffect(() => {
    updatePillView()
  }, [updatePillView])

  const paginateScroll = useThrottledScroll(
    scrollRef,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  )
  const handleScroll = useCallback(() => {
    paginateScroll()
    updatePillView()
  }, [paginateScroll, updatePillView])

  // Show "↑ New messages" when unread exists above the viewport (divider row
  // scrolled above the top, or the boundary is still unloaded — §5.7 / §6.2).
  const hasUnreadBoundary = dividerIndex !== -1 || boundaryAboveWindow
  const showJumpToUnread =
    hasUnreadBoundary && (dividerIndex === -1 || pillView.firstIndex > dividerIndex)
  const showJumpToPresent = pillView.distanceFromBottom > 400

  const handleJumpToUnread = useCallback(() => {
    if (dividerIndex !== -1) {
      virtualizer.scrollToIndex(dividerIndex, { align: 'start' })
      return
    }
    // §6.2: boundary above the loaded window. Fetch around the last-read message
    // so the divider renders naturally; if never read, climb history from the top.
    const lastReadId = readState?.lastReadMessageId
    if (lastReadId !== undefined && lastReadId !== null) {
      void jumpToMessage(lastReadId)
    } else {
      virtualizer.scrollToIndex(0, { align: 'start' })
      if (hasNextPage === true && isFetchingNextPage === false) fetchNextPage()
    }
  }, [
    dividerIndex,
    virtualizer,
    readState,
    jumpToMessage,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  ])

  const handleJumpToPresent = useCallback(() => {
    if (virtualItems.length > 0) {
      virtualizer.scrollToIndex(virtualItems.length - 1, { align: 'end' })
    }
  }, [virtualizer, virtualItems.length])

  const { isBlocked, isInputDisabled, isDmInitFailed, inputPlaceholder } = useChatInputState(
    isDm,
    isChannelEncrypted,
    isReadOnly,
    currentUserRole,
    trustLevel,
    dmRecipient,
    channelName,
  )

  async function handleSend() {
    if (channelId === null || isInCooldown) return
    const trimmed = messageContent.trim()
    // WHY gate on attachmentsEnabled: in an encrypted channel the tray is hidden
    // (D7) — never forward stray pending attachments the API would reject (400),
    // even in the transient window before the channel-switch reset clears them.
    const hasAttachments = attachmentsEnabled && attachments.isEmpty === false
    // WHY allow empty content when files are attached: image-only messages are
    // valid (Decision D10). Otherwise an empty send is a no-op.
    if (trimmed.length === 0 && hasAttachments === false) return
    // WHY block on a failed upload: never post a message referencing a file
    // that never reached Storage — the user removes/retries the failed tile
    // first (spec §6.2). Surfaced inline, not as a toast (ADR-028).
    if (attachments.hasFailedUpload === true) {
      attachments.setSendError(t('attachRemoveFailed'))
      return
    }
    const parentId = replyingTo?.id
    // WHY await before clearing: resolveUploaded waits for every in-flight
    // upload so the request never references an un-uploaded URL (spec §6.2).
    // A null return means an upload failed (possibly during the await) → block
    // the send and keep the tray so the user retries/removes the failed tile.
    const uploaded = hasAttachments ? await attachments.resolveUploaded() : []
    if (uploaded === null) {
      attachments.setSendError(t('attachRemoveFailed'))
      return
    }
    setMessageContent('')
    setReplyingTo(null)
    // WHY at send time: the textarea always shows human-readable `@username`;
    // the `<@uuid>` markers exist only at rest and on the wire (spec §5.2).
    const { content, mentionedUsers } = applyMentionMap(trimmed, mention.mentionMapRef.current)
    sendMessage.mutate(
      {
        content,
        parentMessageId: parentId,
        ...(mentionedUsers.length > 0 ? { mentions: mentionedUsers } : {}),
        ...(uploaded.length > 0 ? { attachments: uploaded } : {}),
      },
      {
        // WHY clear only on success: on failure the tray is kept so the
        // already-uploaded URLs are reused on retry (no re-upload, §6.1).
        onSuccess: () => attachments.clear(),
        onError: (error) => {
          // WHY surface inline here (in addition to the hook's generic toast):
          // a plan-cap rejection is an explicit user action failing — the
          // composer shows the actionable detail next to the tray (ADR-028).
          if (hasAttachments === true) {
            attachments.setSendError(getApiErrorDetail(error, t('attachSendFailed')))
          }
        },
      },
    )
    // WHY: Start cooldown optimistically right after sending. If the send fails
    // with 429, the timer is already running. Matches Discord's behavior.
    startCooldown()
  }

  // WHY separate from handleSend: a picked GIF is its own message sent
  // immediately (Discord behavior) — the bare hosted URL is the content, so it
  // auto-embeds via the inline-image render path. It rides the same
  // `sendMessage` mutation, so E2EE channels encrypt it like any message.
  function handleSendGif(gifUrl: string) {
    if (channelId === null || isInCooldown) return
    const parentId = replyingTo?.id
    setReplyingTo(null)
    sendMessage.mutate({ content: gifUrl, parentMessageId: parentId })
    startCooldown()
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    // WHY first: while the popup is open the reducer consumes ↑↓/Enter/Tab/Esc —
    // Enter MUST NOT send while a row is highlighted (spec §1 keyboard rules).
    if (mention.handleKeyDown(e)) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }

  if (channelId === null) {
    return <ChatPlaceholder isDm={isDm} />
  }

  return (
    <div data-test="chat-area" className="flex h-full flex-col bg-background">
      <ChatToolbar
        isDm={isDm}
        dmRecipient={dmRecipient}
        channelName={channelName}
        channelId={channelId}
        isChannelEncrypted={isChannelEncrypted}
        onOpenVerify={() => setIsVerifyOpen(true)}
      />

      <Divider />

      {/* Virtualized message list + floating jump pills */}
      <div className="relative flex-1 overflow-hidden">
        {showJumpToUnread && (
          <Button
            size="sm"
            variant="flat"
            color="danger"
            startContent={<ChevronUp className="h-3 w-3" />}
            onPress={handleJumpToUnread}
            data-test="jump-to-unread"
            className="-translate-x-1/2 absolute top-2 left-1/2 z-10"
          >
            {t('jumpToNewMessages')}
          </Button>
        )}
        {showJumpToPresent && (
          <Button
            size="sm"
            variant="flat"
            color="default"
            startContent={<ChevronDown className="h-3 w-3" />}
            onPress={handleJumpToPresent}
            data-test="jump-to-present"
            className="-translate-x-1/2 absolute bottom-2 left-1/2 z-10"
          >
            {t('jumpToPresent')}
          </Button>
        )}
        <div
          data-test="message-list"
          ref={scrollRef}
          onScroll={handleScroll}
          className="h-full overflow-y-auto"
        >
          <MessageListStatus
            isDm={isDm}
            isChannelEncrypted={isChannelEncrypted}
            channelId={channelId}
            channelName={channelName}
            dmRecipient={dmRecipient}
            hasNextPage={hasNextPage}
            isFetchingNextPage={isFetchingNextPage}
            isPending={isPending}
            isError={isError}
            messageCount={messages.length}
            onRetry={() => refetch()}
            isRetrying={isRefetching}
          />

          {/* WHY: Virtualizer container is separate — only absolute-positioned items inside.
            getTotalSize() is accurate because it only accounts for measured message rows. */}
          <div
            className={isError && messages.length > 0 ? 'opacity-70' : undefined}
            style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const item = virtualItems[virtualRow.index]
              if (!item) return null

              const key =
                item.type === 'date'
                  ? `date-${virtualRow.index}`
                  : item.type === 'new-messages'
                    ? 'new-messages'
                    : item.msg.id

              return (
                <div
                  key={key}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  {item.type === 'date' ? (
                    <DateDivider label={item.label} />
                  ) : item.type === 'new-messages' ? (
                    <NewMessagesDivider />
                  ) : (
                    <MessageItem
                      message={item.msg}
                      currentUserId={currentUser.id}
                      serverId={serverId}
                      canModerateMessages={
                        ROLE_HIERARCHY[currentUserRole] >= ROLE_HIERARCHY.moderator
                      }
                      isEditing={editingMessageId === item.msg.id}
                      isGrouped={item.isGrouped}
                      isFlashing={flashMessageId === item.msg.id}
                      onJumpToParent={
                        item.msg.parentMessageId !== undefined && item.msg.parentMessageId !== null
                          ? () => {
                              const parentId = item.msg.parentMessageId
                              if (parentId !== undefined && parentId !== null) {
                                void jumpToMessage(parentId)
                              }
                            }
                          : undefined
                      }
                      onStartEdit={() => handleStartEdit(item.msg.id)}
                      onSaveEdit={(content) => handleSaveEdit(item.msg.id, content)}
                      onCancelEdit={handleCancelEdit}
                      onDelete={() => handleDelete(item.msg.id)}
                      onReply={() => setReplyingTo(item.msg)}
                      onAddReaction={(emoji) =>
                        addReactionMutation.mutate({ messageId: item.msg.id, emoji })
                      }
                      onRemoveReaction={(emoji) =>
                        removeReactionMutation.mutate({ messageId: item.msg.id, emoji })
                      }
                      isDm={isDm}
                      isChannelEncrypted={isChannelEncrypted}
                      decryptMessage={decryptMessage}
                      decryptChannelMessage={decryptChannelMessage}
                      getCachedPlaintext={
                        isChannelEncrypted ? getChannelCachedPlaintext : getCachedPlaintext
                      }
                    />
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* Typing indicator */}
      <TypingIndicator typingUsers={typingUsers} />

      <ReplyBar replyingTo={replyingTo} onCancel={() => setReplyingTo(null)} />

      <ChatInputSection
        isBlocked={isBlocked}
        isInputDisabled={isInputDisabled}
        inputPlaceholder={inputPlaceholder}
        messageContent={messageContent}
        isDmInitFailed={isDmInitFailed}
        slowModeRemainingSeconds={remainingSeconds}
        onValueChange={setMessageContent}
        onKeyDown={handleKeyDown}
        onSendTyping={() => sendTyping(currentUser.username)}
        onGifSelect={handleSendGif}
        mention={mention}
        textareaRef={composerRef}
        attachments={attachments}
        attachmentsEnabled={attachmentsEnabled}
      />

      {/* Verify identity modal — only rendered on desktop DMs */}
      {isDm && isTauri() && (
        <VerifyIdentityModal
          isOpen={isVerifyOpen}
          onClose={() => setIsVerifyOpen(false)}
          recipientName={
            dmRecipient !== null ? (dmRecipient.displayName ?? dmRecipient.username) : ''
          }
          safetyNumber={safetyNumber}
          isLoadingSafetyNumber={isLoadingSafetyNumber}
          trustLevel={trustLevel}
          onSetTrustLevel={setTrustLevelFn}
        />
      )}
    </div>
  )
}
