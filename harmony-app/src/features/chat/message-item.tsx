import { Avatar, Button, Textarea, Tooltip } from '@heroui/react'
import type { TFunction } from 'i18next'
import {
  ArrowRight,
  Lock,
  LockOpen,
  MessageSquare,
  Pencil,
  Pin,
  PinOff,
  SmilePlus,
  Trash2,
} from 'lucide-react'
import { type ComponentPropsWithoutRef, memo, useCallback, useMemo, useRef, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import { ExternalLinkWarning } from '@/components/shared/external-link-warning'
import type { DecryptResult } from '@/features/crypto'
import { EncryptedMessageContent } from '@/features/crypto'
import { usePreferences } from '@/features/preferences'
import { OfficialBadge, ProfilePopover, useOfficialBadges } from '@/features/profiles'
import {
  extendSanitizeForEmoji,
  parseEmojiToken,
  remarkCustomEmoji,
  useServerEmojiMap,
} from '@/features/server-emojis'
import type { EmojiResponse, MessageResponse } from '@/lib/api'
import { resolveDisplayName } from '@/lib/display-name'
import { isTauri } from '@/lib/platform'
import { maskProfanity } from '@/lib/profanity-filter'
import { MentionPill } from './components/mention-pill'
import { MentionText } from './components/mention-text'
import { EmbeddedImage, MessageAttachments } from './components/message-attachments'
import { MessageEmbeds } from './components/message-embeds'
import { EmojiPickerPopover } from './emoji-picker-popover'
import { useEditBuffer } from './hooks/use-edit-buffer'
import { isEmbeddableImageUrl } from './lib/attachment-file'
import {
  applyMentionMap,
  markersToEditable,
  mentionsToMap,
  remarkMentions,
} from './lib/mention-tokens'
import { messageSanitizeSchema } from './lib/message-sanitize'

// WHY module-level: the schema never changes — extend the shared mention/image
// sanitize schema once to allowlist the custom-emoji span's data attributes.
const emojiSanitizeSchema = extendSanitizeForEmoji(messageSanitizeSchema)

/**
 * Renders a resolved custom emoji as a small inline image. Sizing mirrors
 * Discord's inline emoji (~1.375em tall, baseline-nudged) via Tailwind
 * arbitrary values — no global CSS, no inline style (ADR-044).
 */
function InlineCustomEmoji({ name, url }: { name: string; url: string }) {
  return (
    <img
      src={url}
      alt={`:${name}:`}
      className="inline-block h-[1.375em] w-auto align-[-0.25em]"
      draggable={false}
      data-test="inline-custom-emoji"
    />
  )
}

interface MessageItemProps {
  message: MessageResponse
  currentUserId: string
  /** WHY: Server context for the mention pill's members-cache fallback. Null in DMs. */
  serverId?: string | null
  /** WHY: When true, the delete button appears on ALL messages (not just own). */
  canModerateMessages: boolean
  isEditing: boolean
  /** WHY: When true, hides avatar and header to visually group consecutive same-author messages. */
  isGrouped?: boolean
  /** WHY: Briefly tints the row after a jump-to-message lands on it (§5.10). */
  isFlashing?: boolean
  /** WHY: Jump to this message's replied-to parent (§5.9). Absent = quote not clickable. */
  onJumpToParent?: () => void
  onStartEdit: () => void
  onSaveEdit: (content: string) => void
  onCancelEdit: () => void
  onDelete: () => void
  /** WHY: Toggle pin state (moderator+). Absent = pin affordance hidden. */
  onTogglePin?: () => void
  /** WHY: Disables the pin button + shows a spinner while the mutation is in flight. */
  isPinPending?: boolean
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

// WHY: Bare domains like "evil.com" have no protocol, so rehype-sanitize strips
// the href entirely. Prepending "https://" before sanitization makes them pass
// the protocol whitelist and renders a clickable (but still warning-gated) link.
const PROTOCOL_RE = /^[a-z][a-z\d+\-.]*:/i
function normalizeUrl(url: string): string {
  if (!PROTOCOL_RE.test(url)) {
    return `https://${url}`
  }
  return url
}

/**
 * WHY: The remark plugin emits spans with `data-mention-id`; hast property
 * names reach React props in their hyphenated attribute form, so the override
 * reads the hyphenated key. `node` is react-markdown's ExtraProps.
 */
type MarkdownSpanProps = ComponentPropsWithoutRef<'span'> & {
  node?: unknown
  'data-mention-id'?: string
  'data-emoji-name'?: string
  'data-emoji-url'?: string
}

// WHY extracted: Reduces MessageItem cognitive complexity below Biome's limit of 15.
function MessageContent({
  message,
  serverId,
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
  serverId: string | null
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
  const [pendingUrl, setPendingUrl] = useState<string | null>(null)
  const { data: prefs } = usePreferences()
  const hideProfanity = prefs?.hideProfanity ?? true
  // WHY: `:name:` tokens resolve against this server's emoji. Empty while the
  // query loads ⇒ tokens stay literal, then re-render on cache fill (§1).
  const emojiMap = useServerEmojiMap(serverId)
  // WHY the () => wrapper (not remarkCustomEmoji(emojiMap) passed directly):
  // unified treats each array item as an attacher it CALLS to obtain the
  // transformer. Passing the already-called transformer makes unified invoke it
  // with no tree and register its (undefined) return value — a silent no-op.
  // Wrapping in an attacher (like remarkMentions, which unified calls to get its
  // transformer) makes unified call remarkCustomEmoji(emojiMap) itself.
  const remarkPlugins = useMemo(
    () => [remarkGfm, remarkMentions, () => remarkCustomEmoji(emojiMap)],
    [emojiMap],
  )

  // WHY: Defense-in-depth — rehype-sanitize already strips dangerous protocols,
  // but we re-check here to guard against future config changes or plugin swaps.
  // Shared by links, embedded content images and markdown images.
  const handleGatedOpen = useCallback((href: string) => {
    const isAllowedProtocol =
      href.startsWith('https://') || href.startsWith('http://') || href.startsWith('mailto:')
    if (isAllowedProtocol) {
      setPendingUrl(href)
    }
  }, [])

  const handleLinkClick = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>, href: string) => {
      e.preventDefault()
      handleGatedOpen(href)
    },
    [handleGatedOpen],
  )

  const handleLinkContinue = useCallback(() => {
    if (pendingUrl === null) return
    window.open(pendingUrl, '_blank', 'noopener,noreferrer')
    setPendingUrl(null)
  }, [pendingUrl])

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
          // WHY render prop (not a crypto→chat import): E2EE messages parse
          // mentions post-decrypt (spec §5.3), and injecting the renderer from
          // chat avoids a circular feature dependency (chat already imports crypto).
          renderPlaintext={(plaintext) => (
            <MentionText content={plaintext} mentions={message.mentions} serverId={serverId} />
          )}
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
        remarkPlugins={remarkPlugins}
        rehypePlugins={[[rehypeSanitize, emojiSanitizeSchema]]}
        urlTransform={normalizeUrl}
        components={{
          p: ({ children }) => <p className="mb-1 last:mb-0">{children}</p>,
          // WHY: remark plugins emit spans carrying data-mention-id (mentions)
          // or data-emoji-name/url (custom emoji) — render each as its element;
          // any other span falls through untouched.
          span: ({
            node: _node,
            'data-mention-id': mentionId,
            'data-emoji-name': emojiName,
            'data-emoji-url': emojiUrl,
            ...rest
          }: MarkdownSpanProps) =>
            mentionId !== undefined ? (
              <MentionPill userId={mentionId} mentions={message.mentions} serverId={serverId} />
            ) : emojiName !== undefined && emojiUrl !== undefined ? (
              <InlineCustomEmoji name={emojiName} url={emojiUrl} />
            ) : (
              <span {...rest} />
            ),
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
          // WHY: Prevent `*****` (AutoMod masked content) from rendering as a
          // CommonMark thematic break (<hr>). Defense-in-depth — backend now
          // escapes `*` as `\*`, but old messages in DB may still have unescaped `*`.
          hr: () => <span className="text-default-400">*****</span>,
          // WHY the image branch: a bare image/GIF URL typed into content
          // auto-embeds inline (the T1.4/Klipy path) instead of rendering as
          // a link. Opening stays gated by the same ExternalLinkWarning flow.
          a: ({ href, children }) =>
            href !== undefined && isEmbeddableImageUrl(href) ? (
              <EmbeddedImage src={href} alt="" onOpen={handleGatedOpen} />
            ) : (
              <a
                href={href}
                onClick={(e) => {
                  if (href !== undefined) handleLinkClick(e, href)
                }}
                className="cursor-pointer text-primary underline"
              >
                {children}
              </a>
            ),
          // WHY: markdown images (`![alt](url)`) render bounded + lazy with
          // the gated open and the onError "unavailable" fallback.
          img: ({ src, alt }) =>
            typeof src === 'string' && src !== '' ? (
              <EmbeddedImage src={src} alt={alt ?? ''} onOpen={handleGatedOpen} />
            ) : null,
        }}
      >
        {hideProfanity ? maskProfanity(message.content) : message.content}
      </ReactMarkdown>
      {message.editedAt !== undefined && message.editedAt !== null && (
        <span className="ml-1 text-xs text-default-400" data-test="message-edited-indicator">
          {t('edited')}
        </span>
      )}
      <ExternalLinkWarning
        isOpen={pendingUrl !== null}
        url={pendingUrl ?? ''}
        onClose={() => setPendingUrl(null)}
        onContinue={handleLinkContinue}
      />
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
      className="flex items-center gap-2 px-4 pt-3 pb-0.5 text-sm text-default-500"
    >
      <ArrowRight className="h-4 w-4 shrink-0" />
      <span>{text}</span>
      <span className="text-xs text-default-400">{formatTimestamp(message.createdAt, t)}</span>
    </div>
  )
}

// WHY extracted: Reduces MessageItem cognitive complexity below Biome's limit of 15.
function ParentQuote({
  parentMessage,
  onJump,
}: {
  parentMessage?: MessageResponse['parentMessage']
  onJump?: () => void
}) {
  const { t } = useTranslation('messages')
  if (parentMessage === undefined || parentMessage === null) return null

  const body =
    parentMessage.deleted === true ? (
      <p className="text-xs italic text-default-400">{t('deletedParentMessage')}</p>
    ) : (
      <>
        <span className="text-xs font-medium">{parentMessage.authorUsername}</span>
        <p className="truncate text-xs text-default-500">{parentMessage.contentPreview}</p>
      </>
    )

  // WHY not clickable without onJump: a jump handler only exists inside a
  // channel view; keeping the plain div otherwise avoids a dead affordance.
  if (onJump === undefined) {
    return <div className="mb-1 border-l-2 border-default-300 pl-2 opacity-75">{body}</div>
  }

  return (
    <button
      type="button"
      aria-label={t('jumpToRepliedMessage')}
      onClick={onJump}
      className="mb-1 block w-full cursor-pointer border-default-300 border-l-2 pl-2 text-left opacity-75 transition-opacity hover:opacity-100 focus:outline-none focus-visible:opacity-100"
    >
      {body}
    </button>
  )
}

// WHY exported: keeps ReactionBar's cognitive complexity under Biome's limit of
// 15, isolates the "who reacted" rendering (names, overflow, fallback), and lets
// the content be unit-tested directly (HeroUI's Tooltip portal does not open
// reliably under jsdom synthetic events).
export function ReactionTooltipContent({
  reaction,
}: {
  reaction: NonNullable<MessageResponse['reactions']>[number]
}) {
  const { t } = useTranslation('chat')
  const { emoji, count, reactors } = reaction

  // Degraded / version-skew fallback: a message cached before the API regen (or
  // an unexpected null) has no reactor detail — never render an empty tooltip.
  if (reactors === undefined || reactors.length === 0) {
    return <span className="text-xs">{t('reactorsCount', { count })}</span>
  }

  const names = reactors.map((r) =>
    resolveDisplayName({ displayName: r.displayName, username: r.username }),
  )
  const overflow = count - reactors.length

  return (
    <div className="max-w-[16rem] px-1 py-0.5 text-xs">
      <span className="mr-1">{emoji}</span>
      <span>{names.join(', ')}</span>
      {overflow > 0 && (
        <span className="text-default-400"> {t('reactorsOthers', { count: overflow })}</span>
      )}
    </div>
  )
}

// WHY extracted: Reduces MessageItem cognitive complexity below Biome's limit of 15.
/** Render a reaction key: a custom `:name:` in the map → image, else the raw text. */
function ReactionEmoji({
  emoji,
  emojiMap,
}: {
  emoji: string
  emojiMap: ReadonlyMap<string, EmojiResponse>
}) {
  const name = parseEmojiToken(emoji)
  const custom = name !== null ? emojiMap.get(name) : undefined
  if (custom !== undefined) {
    return <InlineCustomEmoji name={custom.name} url={custom.url} />
  }
  return <span>{emoji}</span>
}

function ReactionBar({
  reactions,
  isDeleted,
  serverId,
  emojiMap,
  onAddReaction,
  onRemoveReaction,
}: {
  reactions: MessageResponse['reactions']
  isDeleted: boolean
  serverId: string | null
  emojiMap: ReadonlyMap<string, EmojiResponse>
  onAddReaction?: (emoji: string) => void
  onRemoveReaction?: (emoji: string) => void
}) {
  const { t } = useTranslation('chat')
  const [isPickerOpen, setIsPickerOpen] = useState(false)

  if (reactions === undefined || reactions.length === 0 || isDeleted) return null

  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {reactions.map((r) => (
        <Tooltip
          key={r.emoji}
          content={<ReactionTooltipContent reaction={r} />}
          placement="top"
          delay={300}
          closeDelay={0}
        >
          <button
            type="button"
            data-test="reaction-pill"
            onClick={() =>
              r.reactedByMe === true ? onRemoveReaction?.(r.emoji) : onAddReaction?.(r.emoji)
            }
            className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors${r.reactedByMe === true ? ' border-accent bg-accent/10 text-accent' : ' border-default-200 bg-default-50 hover:bg-default-100'}`}
          >
            <ReactionEmoji emoji={r.emoji} emojiMap={emojiMap} />
            <span>{r.count}</span>
          </button>
        </Tooltip>
      ))}
      {/* WHY: Second Discord-parity entry point — start ANOTHER reaction from the bar itself. */}
      {onAddReaction !== undefined && (
        <EmojiPickerPopover
          isOpen={isPickerOpen}
          onOpenChange={setIsPickerOpen}
          onEmojiSelect={onAddReaction}
          serverId={serverId}
          placement="top-start"
        >
          <button
            type="button"
            aria-label={t('addReaction')}
            data-test="reaction-add-button"
            className="flex items-center rounded-full border border-default-200 bg-default-50 px-2 py-0.5 text-xs text-default-500 transition-colors hover:bg-default-100 hover:text-default-700"
          >
            <SmilePlus className="h-3.5 w-3.5" />
          </button>
        </EmojiPickerPopover>
      )}
    </div>
  )
}

// WHY extracted: Reduces MessageItem cognitive complexity below Biome's limit of 15.
function MessageActions({
  isOwnMessage,
  canModerateMessages,
  isPinned,
  isPinPending,
  serverId,
  onStartEdit,
  onDelete,
  onTogglePin,
  onAddReaction,
  onReply,
}: {
  isOwnMessage: boolean
  canModerateMessages: boolean
  serverId: string | null
  isPinned: boolean
  isPinPending: boolean
  onStartEdit: () => void
  onDelete: () => void
  onTogglePin?: () => void
  onAddReaction?: (emoji: string) => void
  onReply?: () => void
}) {
  const { t } = useTranslation('chat')
  // WHY local state: the bar is CSS-hidden when the row loses hover, but it must
  // stay visible while the picker popover it anchors is open — otherwise the
  // popover would point at a display:none trigger and lose its position.
  const [isPickerOpen, setIsPickerOpen] = useState(false)

  return (
    <div
      data-test="message-actions"
      className={`absolute -top-3 right-4 gap-0.5 rounded-md border border-divider bg-background shadow-sm${isPickerOpen ? ' flex' : ' hidden group-hover:flex'}`}
    >
      {/* WHY first: Discord action order — react, reply, edit, delete. */}
      {onAddReaction !== undefined && (
        <EmojiPickerPopover
          isOpen={isPickerOpen}
          onOpenChange={setIsPickerOpen}
          onEmojiSelect={onAddReaction}
          serverId={serverId}
          placement="bottom-end"
        >
          <Button
            variant="light"
            isIconOnly
            size="sm"
            aria-label={t('addReaction')}
            data-test="message-react-button"
          >
            <SmilePlus className="h-4 w-4 text-default-500" />
          </Button>
        </EmojiPickerPopover>
      )}
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
      {/* WHY between edit and delete: Discord action order (react · reply · edit
          · pin · delete). Moderator+ only; the server is the authoritative gate. */}
      {canModerateMessages && onTogglePin !== undefined && (
        <Button
          variant="light"
          isIconOnly
          size="sm"
          isDisabled={isPinPending}
          isLoading={isPinPending}
          onPress={onTogglePin}
          aria-label={isPinned ? t('unpinMessage') : t('pinMessage')}
          aria-pressed={isPinned}
          data-test="message-pin-button"
        >
          {isPinned ? (
            <PinOff className="h-4 w-4 text-default-500" />
          ) : (
            <Pin className="h-4 w-4 text-default-500" />
          )}
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
  )
}

// WHY extracted: Reduces MessageItem cognitive complexity below Biome's limit of 15.
function MessageHeader({
  authorLabel,
  isPending,
  message,
  isDm,
  serverId,
}: {
  authorLabel: string
  isPending: boolean
  message: MessageResponse
  isDm: boolean
  serverId: string | null
}) {
  const { t } = useTranslation('messages')
  const { t: tCrypto } = useTranslation('crypto')
  const { t: tChat } = useTranslation('chat')
  // WHY the shared set (not a per-message flag): the badge renders next to every
  // author, so author-id membership is checked against one cached set rather
  // than bloating each message payload (see use-official-badges).
  const officialUserIds = useOfficialBadges()

  return (
    <div className="flex items-baseline gap-2">
      <ProfilePopover userId={message.authorId} serverId={serverId}>
        {/* biome-ignore lint/a11y/useSemanticElements: HeroUI PopoverTrigger makes this
            span pressable (adds keyboard/aria at runtime); a real <button> would break
            the inline baseline text styling of the author name */}
        <span
          data-test="message-author"
          role="button"
          tabIndex={0}
          className="cursor-pointer font-medium text-foreground hover:underline"
        >
          {authorLabel}
        </span>
      </ProfilePopover>
      <OfficialBadge isOfficial={officialUserIds.has(message.authorId)} />
      <span data-test="message-timestamp" className="text-xs text-default-500">
        {isPending ? t('sending') : formatTimestamp(message.createdAt, t)}
      </span>
      {/* WHY derived from the cache (ADR-045), no useState shadow: mirrors the
          `edited` tag treatment. A small muted glyph, quiet like metadata. */}
      {message.isPinned && (
        <span
          data-test="message-pinned-tag"
          className="inline-flex items-center gap-1 text-xs text-default-400"
        >
          <Pin className="h-3 w-3" />
          {tChat('pinnedTag')}
        </span>
      )}
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
 * Mention-aware edit buffer (spec §5.3): the buffer shows `@username`, never
 * raw `<@uuid>`; saving re-applies markers from a map built from the message's
 * own mentions, so hand-typed names stay plain text. Encrypted content is
 * ciphertext — never transformed (no sidecar on edits in v1).
 */
function useMentionAwareEditBuffer(
  message: MessageResponse,
  isEditing: boolean,
  onSaveEdit: (content: string) => void,
) {
  const isCiphertext = message.encrypted === true
  const editSeed = isCiphertext
    ? message.content
    : markersToEditable(message.content, message.mentions)
  const { editContent, setEditContent } = useEditBuffer(editSeed, isEditing)

  const handleSaveEdit = useCallback(
    (content: string) => {
      if (isCiphertext) {
        onSaveEdit(content)
        return
      }
      onSaveEdit(applyMentionMap(content, mentionsToMap(message.mentions)).content)
    },
    [isCiphertext, message.mentions, onSaveEdit],
  )

  return { editContent, setEditContent, handleSaveEdit }
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
  serverId = null,
  canModerateMessages,
  isEditing,
  isGrouped = false,
  isFlashing = false,
  onJumpToParent,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onDelete,
  onTogglePin,
  isPinPending = false,
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
  // WHY here (not only in MessageContent): the ReactionBar renders custom
  // `:name:` reaction pills as images too — both read the same cached map.
  const emojiMap = useServerEmojiMap(serverId)
  // WHY: Hooks must be called before any conditional returns (React rules of hooks).
  // The buffer is seeded when editing OPENS (not at mount) so a message edited
  // via SSE/AutoMod in between never leaks stale content into the editor
  // (ADR-045) — see use-edit-buffer.ts, including the AutoMod `\*` unescape.
  const { editContent, setEditContent, handleSaveEdit } = useMentionAwareEditBuffer(
    message,
    isEditing,
    onSaveEdit,
  )

  // WHY: System messages have a completely different layout — early return.
  if (message.messageType === 'system') {
    return <SystemMessageItem message={message} t={t} />
  }

  // WHY: Render the account display_name over the raw username. Message payloads
  // carry authorDisplayName (profile display name) but NOT a per-server nickname,
  // so the nickname tier is intentionally absent here.
  const authorLabel = resolveDisplayName({
    displayName: message.authorDisplayName,
    username: message.authorUsername,
  })

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

  // WHY derive from the server-validated field (not rendered pills): E2EE
  // "ghost pings" (sidecar without visible markers) must still tint the row so
  // they are visible and reportable (spec §5.3). Deleted messages never tint.
  const mentionsMe =
    isDeleted === false && message.mentions?.some((m) => m.userId === currentUserId) === true

  return (
    <div
      data-test="message-item"
      data-message-id={message.id}
      data-test-mentions-me={mentionsMe ? 'true' : undefined}
      className={`group relative flex gap-4 px-4 transition-colors hover:bg-default-200/50${mentionsMe ? ' border-l-2 border-warning bg-warning/10' : ''}${isFlashing ? ' ring-2 ring-warning/40 ring-inset' : ''}${isPending ? ' opacity-60' : ''}${isGrouped ? ' py-0.5' : ' pt-3 pb-0.5'}`}
    >
      {isGrouped ? (
        <div className="w-10 shrink-0" />
      ) : (
        <ProfilePopover userId={message.authorId} serverId={serverId}>
          <Avatar
            name={authorLabel}
            src={message.authorAvatarUrl ?? undefined}
            color="primary"
            size="md"
            showFallback
            className="cursor-pointer"
            classNames={{
              base: 'mt-0.5 h-10 w-10 shrink-0',
              name: 'text-sm',
            }}
          />
        </ProfilePopover>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        {!isGrouped && (
          <MessageHeader
            authorLabel={authorLabel}
            isPending={isPending}
            message={message}
            isDm={isDm}
            serverId={serverId}
          />
        )}

        <ParentQuote parentMessage={message.parentMessage} onJump={onJumpToParent} />

        <MessageContent
          message={message}
          serverId={serverId}
          isEncrypted={isEncrypted}
          isDeleted={isDeleted}
          isModeratorDeleted={isModeratorDeleted}
          isEditing={isEditing}
          editContent={editContent}
          setEditContent={setEditContent}
          onSaveEdit={handleSaveEdit}
          onCancelEdit={onCancelEdit}
          decryptMessage={activeDecryptFn}
          getCachedPlaintext={getCachedPlaintext}
        />

        {/* WHY inside the non-deleted branch: tombstoned messages never render
            their attachment block (storage objects are retained server-side). */}
        {isDeleted === false && (message.attachments ?? []).length > 0 && (
          <MessageAttachments attachments={message.attachments ?? []} />
        )}

        {/* WHY hidden while pending: optimistic messages carry a temp id the
            removal endpoint would reject; previews only ever arrive on the
            real message via message.updated anyway. */}
        {isDeleted === false && isPending === false && (message.embeds ?? []).length > 0 && (
          <MessageEmbeds
            messageId={message.id}
            channelId={message.channelId}
            embeds={message.embeds ?? []}
            canRemove={isOwnMessage || canModerateMessages}
          />
        )}

        <ReactionBar
          reactions={message.reactions}
          isDeleted={isDeleted}
          serverId={serverId}
          emojiMap={emojiMap}
          onAddReaction={onAddReaction}
          onRemoveReaction={onRemoveReaction}
        />
      </div>

      {/* WHY: Actions bar shows for non-deleted, non-pending messages.
          React and reply are available to everyone. Edit is own-message-only.
          Delete shows for own messages OR if moderator+. */}
      {isEditing === false && isPending === false && isDeleted === false && (
        <MessageActions
          isOwnMessage={isOwnMessage}
          canModerateMessages={canModerateMessages}
          isPinned={message.isPinned}
          isPinPending={isPinPending}
          serverId={serverId}
          onStartEdit={onStartEdit}
          onDelete={onDelete}
          onTogglePin={onTogglePin}
          onAddReaction={onAddReaction}
          onReply={onReply}
        />
      )}
    </div>
  )
})
