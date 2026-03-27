import { Avatar, Button, Divider, Spinner, Textarea } from '@heroui/react'
import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual'
import {
  Bell,
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
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuthStore, useCurrentProfile } from '@/features/auth'
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
import { StatusIndicator, useUserStatus } from '@/features/presence'
import type { DmRecipientResponse, MessageResponse } from '@/lib/api'
import { encrypt } from '@/lib/crypto'
import { cacheMessage } from '@/lib/crypto-cache'
import { logger } from '@/lib/logger'
import { isTauri } from '@/lib/platform'
import { useDeleteMessage } from './hooks/use-delete-message'
import { useEditMessage } from './hooks/use-edit-message'
import { useMessages } from './hooks/use-messages'
import { useRealtimeMessages } from './hooks/use-realtime-messages'
import type { SendMessageEncryption } from './hooks/use-send-message'
import { useSendMessage } from './hooks/use-send-message'
import { useTypingIndicator } from './hooks/use-typing-indicator'
import { MessageItem } from './message-item'
import { TypingIndicator } from './typing-indicator'

interface ChatAreaProps {
  channelId: string | null
  channelName: string | null
  currentUserRole: MemberRole
  /** WHY: When true, renders a DM-style header (avatar + name) instead of # channel-name */
  isDm?: boolean
  /** WHY: Recipient info for DM header display. Only used when isDm is true. */
  dmRecipient?: DmRecipientResponse | null
  /** WHY: When true and user role < admin, the message input is disabled. */
  isReadOnly?: boolean
  /** WHY: When true, messages are Megolm-encrypted. Derived from channel.encrypted in parent. */
  isChannelEncrypted?: boolean
}

/**
 * WHY deduplication here: Two cache update paths exist — realtime INSERT and
 * sendMessage mutation invalidation. They can race, producing duplicate messages
 * in the page cache. Deduplicating at the flatten step is the safest approach
 * since it handles all race conditions regardless of source.
 */
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
) {
  const safeChannelId = channelId ?? ''
  const sendMessage = useSendMessage(safeChannelId, currentUserId, currentUsername, encryption)
  const editMessageMutation = useEditMessage(safeChannelId)
  const deleteMessageMutation = useDeleteMessage(safeChannelId)
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
  const displayName = recipient.displayName ?? recipient.username
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
  isChannelEncrypted,
  onOpenVerify,
}: {
  isDm: boolean
  dmRecipient: DmRecipientResponse | null
  channelName: string | null
  isChannelEncrypted: boolean
  onOpenVerify: () => void
}) {
  const { t } = useTranslation('chat')

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
        <Button variant="light" isIconOnly size="sm" aria-label={t('notifications')}>
          <Bell className="h-5 w-5 text-default-500" />
        </Button>
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

// WHY extracted: Keeps ChatArea below Biome's cognitive complexity limit of 15.
function MessageInput({
  isInputDisabled,
  placeholder,
  value,
  onValueChange,
  onKeyDown,
  onSendTyping,
}: {
  isInputDisabled: boolean
  placeholder: string
  value: string
  onValueChange: (value: string) => void
  onKeyDown: (e: React.KeyboardEvent) => void
  onSendTyping: () => void
}) {
  const { t } = useTranslation('chat')

  return (
    <div className="px-4 pb-6 pt-1">
      <div className="relative flex items-center rounded-lg bg-default-100">
        {!isInputDisabled && (
          <Button
            variant="light"
            isIconOnly
            size="sm"
            className="ml-1 shrink-0"
            aria-label={t('attachFile')}
          >
            <PlusCircle className="h-5 w-5 text-default-500" />
          </Button>
        )}
        <Textarea
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
          onKeyDown={isInputDisabled ? undefined : onKeyDown}
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
            <Button variant="light" isIconOnly size="sm" aria-label={t('emojiPicker')}>
              <SmilePlus className="h-5 w-5 text-default-500" />
            </Button>
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
    const displayName = dmRecipient.displayName ?? dmRecipient.username
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

  const dmDisplayName =
    dmRecipient !== null ? (dmRecipient.displayName ?? dmRecipient.username) : null

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
  }, [isDm, isDesktop, isInitialized, recipientUserId, deviceId, ensureSession])
}

/**
 * WHY extracted: Builds the E2EE encryption parameter for encrypted channel messages.
 * Returns undefined when encryption is not applicable (not encrypted, not desktop, no crypto).
 * Follows the same pattern as useDmEncryption above.
 */
function useChannelEncryptionParam(
  isChannelEncrypted: boolean,
  channelId: string | null,
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
        cacheMessage(messageId, chId, plaintext, new Date().toISOString()).catch((err: unknown) => {
          logger.warn('cache_plaintext_failed', {
            messageId,
            error: err instanceof Error ? err.message : String(err),
          })
        })
      },
    }
  }, [isChannelEncrypted, isDesktop, isInitialized, channelId, deviceId, encryptChannelMessage])
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
  onValueChange,
  onKeyDown,
  onSendTyping,
}: {
  isBlocked: boolean
  isInputDisabled: boolean
  inputPlaceholder: string
  messageContent: string
  /** WHY: When true, E2EE init failed and this is a DM — warn that messages will be plaintext. */
  isDmInitFailed: boolean
  onValueChange: (value: string) => void
  onKeyDown: (e: React.KeyboardEvent) => void
  onSendTyping: () => void
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
      <MessageInput
        isInputDisabled={isInputDisabled}
        placeholder={isBlocked ? tCrypto('blockedCannotSend') : inputPlaceholder}
        value={messageContent}
        onValueChange={onValueChange}
        onKeyDown={onKeyDown}
        onSendTyping={onSendTyping}
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

      {isError && <p className="px-4 text-sm text-danger">{t('failedToLoadMessages')}</p>}

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
  currentUserRole,
  isDm = false,
  dmRecipient = null,
  isReadOnly = false,
  isChannelEncrypted = false,
}: ChatAreaProps) {
  const currentUser = useCurrentUser()

  // WHY: Build encryption param for DMs on desktop. Undefined for channels or web.
  const dmEncryption = useDmEncryption(isDm, dmRecipient?.id ?? null)
  // WHY: Build encryption param for encrypted channels on desktop.
  const channelEncryption = useChannelEncryptionParam(isChannelEncrypted, channelId)
  // WHY: Use channel encryption if available, else DM encryption, else undefined.
  const activeEncryption = channelEncryption ?? dmEncryption
  const { decryptMessage, loadCachedDecryptions, getCachedPlaintext } = useEncryptedMessages()
  const {
    decryptChannelMessage,
    loadCachedChannelDecryptions,
    getCachedPlaintext: getChannelCachedPlaintext,
  } = useChannelEncryption()

  const { data, isPending, isError, hasNextPage, isFetchingNextPage, fetchNextPage } =
    useMessages(channelId)
  const {
    sendMessage,
    editingMessageId,
    handleStartEdit,
    handleCancelEdit,
    handleSaveEdit,
    handleDelete,
  } = useMessageActions(channelId, currentUser.id, currentUser.username, activeEncryption)
  const [messageContent, setMessageContent] = useState('')
  const [isVerifyOpen, setIsVerifyOpen] = useState(false)

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
  const { typingUsers, sendTyping } = useTypingIndicator(channelId ?? '', currentUser.id)

  const messages = useFlatMessages(data)
  const scrollRef = useRef<HTMLDivElement>(null)

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 52,
    overscan: 10,
  })

  useAutoScroll(scrollRef, messages.length, channelId, virtualizer)

  const handleScroll = useThrottledScroll(scrollRef, hasNextPage, isFetchingNextPage, fetchNextPage)

  const { isBlocked, isInputDisabled, isDmInitFailed, inputPlaceholder } = useChatInputState(
    isDm,
    isChannelEncrypted,
    isReadOnly,
    currentUserRole,
    trustLevel,
    dmRecipient,
    channelName,
  )

  function handleSend() {
    const trimmed = messageContent.trim()
    if (trimmed.length === 0 || channelId === null) return
    setMessageContent('')
    sendMessage.mutate(trimmed)
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
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
        isChannelEncrypted={isChannelEncrypted}
        onOpenVerify={() => setIsVerifyOpen(true)}
      />

      <Divider />

      {/* Virtualized message list */}
      <div
        data-test="message-list"
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto"
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
        />

        {/* WHY: Virtualizer container is separate — only absolute-positioned items inside.
            getTotalSize() is accurate because it only accounts for measured message rows. */}
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const message = messages[virtualRow.index]
            if (!message) return null

            return (
              <div
                key={message.id}
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
                <MessageItem
                  message={message}
                  currentUserId={currentUser.id}
                  canModerateMessages={ROLE_HIERARCHY[currentUserRole] >= ROLE_HIERARCHY.moderator}
                  isEditing={editingMessageId === message.id}
                  onStartEdit={() => handleStartEdit(message.id)}
                  onSaveEdit={(content) => handleSaveEdit(message.id, content)}
                  onCancelEdit={handleCancelEdit}
                  onDelete={() => handleDelete(message.id)}
                  isDm={isDm}
                  isChannelEncrypted={isChannelEncrypted}
                  decryptMessage={decryptMessage}
                  decryptChannelMessage={decryptChannelMessage}
                  getCachedPlaintext={
                    isChannelEncrypted ? getChannelCachedPlaintext : getCachedPlaintext
                  }
                />
              </div>
            )
          })}
        </div>
      </div>

      {/* Typing indicator */}
      <TypingIndicator typingUsers={typingUsers} />

      <ChatInputSection
        isBlocked={isBlocked}
        isInputDisabled={isInputDisabled}
        inputPlaceholder={inputPlaceholder}
        messageContent={messageContent}
        isDmInitFailed={isDmInitFailed}
        onValueChange={setMessageContent}
        onKeyDown={handleKeyDown}
        onSendTyping={() => sendTyping(currentUser.username)}
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
