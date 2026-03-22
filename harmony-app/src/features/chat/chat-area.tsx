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
  SmilePlus,
  Sticker,
  Users,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'
import { useAuthStore } from '@/features/auth'
import type { MemberRole } from '@/features/members'
import { StatusIndicator, useUserStatus } from '@/features/presence'
import type { DmRecipientResponse, MessageResponse } from '@/lib/api'
import { useDeleteMessage } from './hooks/use-delete-message'
import { useEditMessage } from './hooks/use-edit-message'
import { useMessages } from './hooks/use-messages'
import { useRealtimeMessages } from './hooks/use-realtime-messages'
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
 * WHY Zod: user_metadata is external data from Supabase Auth (CLAUDE.md §1.2).
 * Using `as string` would lie to the compiler if the shape ever changes.
 * Fallback to email prefix ensures a display name always exists.
 */
const userMetaSchema = z.object({
  username: z.string().optional(),
  display_name: z.string().optional(),
})

function useCurrentUser() {
  const { t } = useTranslation('chat')
  const user = useAuthStore((s) => s.user)
  const id = user?.id ?? ''
  const meta = userMetaSchema.safeParse(user?.user_metadata)
  const username =
    (meta.success ? meta.data.username : undefined) ??
    (meta.success ? meta.data.display_name : undefined) ??
    user?.email?.split('@')[0] ??
    t('unknownUser')
  return { id, username }
}

// WHY extracted: Keeps ChatArea below Biome's cognitive complexity limit of 15.
function useMessageActions(channelId: string | null, currentUserId: string) {
  const safeChannelId = channelId ?? ''
  const sendMessage = useSendMessage(safeChannelId, currentUserId)
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
 * display name, and online status instead of a #channel-name header.
 */
function DmChatHeader({ recipient }: { recipient: DmRecipientResponse }) {
  const displayName = recipient.displayName ?? recipient.username
  const status = useUserStatus(recipient.id)

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
    </div>
  )
}

// WHY: Extracted to reduce ChatArea cognitive complexity below Biome's limit of 15.
function ChatToolbar({
  isDm,
  dmRecipient,
  channelName,
}: {
  isDm: boolean
  dmRecipient: DmRecipientResponse | null
  channelName: string | null
}) {
  const { t } = useTranslation('chat')

  return (
    <div className="flex h-12 items-center justify-between border-b border-divider px-4 shadow-sm">
      {isDm && dmRecipient !== null ? (
        <DmChatHeader recipient={dmRecipient} />
      ) : (
        <div className="flex items-center gap-2">
          <Hash className="h-5 w-5 text-default-500" />
          <span className="font-semibold text-foreground">
            {channelName ?? t('channelFallback')}
          </span>
        </div>
      )}
      <div className="flex items-center gap-1">
        <Button variant="light" isIconOnly size="sm">
          <MessageSquare className="h-5 w-5 text-default-500" />
        </Button>
        <Button variant="light" isIconOnly size="sm">
          <Bell className="h-5 w-5 text-default-500" />
        </Button>
        <Button variant="light" isIconOnly size="sm">
          <Pin className="h-5 w-5 text-default-500" />
        </Button>
        {!isDm && (
          <Button variant="light" isIconOnly size="sm">
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
  return (
    <div className="px-4 pb-6 pt-1">
      <div className="relative flex items-center rounded-lg bg-default-100">
        {!isInputDisabled && (
          <Button variant="light" isIconOnly size="sm" className="ml-1 shrink-0">
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
            inputWrapper: 'border-0 bg-transparent shadow-none',
            input: 'text-sm text-foreground placeholder:text-default-500 px-2 py-3',
          }}
        />
        {!isInputDisabled && (
          <div className="flex shrink-0 items-center gap-0.5 pr-2">
            <Button variant="light" isIconOnly size="sm">
              <Sticker className="h-5 w-5 text-default-500" />
            </Button>
            <Button variant="light" isIconOnly size="sm">
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
  isDm: boolean,
  dmRecipient: DmRecipientResponse | null,
  channelName: string | null,
) {
  const { t } = useTranslation('chat')
  const { t: tDms } = useTranslation('dms')

  if (isInputDisabled) return t('settings:announcementPlaceholder')

  const dmDisplayName =
    dmRecipient !== null ? (dmRecipient.displayName ?? dmRecipient.username) : null

  if (isDm && dmDisplayName !== null) {
    return tDms('dmChatPlaceholder', { username: dmDisplayName })
  }

  return t('messagePlaceholder', { channelName: channelName ?? t('channelFallback') })
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

export function ChatArea({
  channelId,
  channelName,
  currentUserRole,
  isDm = false,
  dmRecipient = null,
  isReadOnly = false,
}: ChatAreaProps) {
  const { t } = useTranslation('chat')
  const currentUser = useCurrentUser()

  const { data, isPending, isError, hasNextPage, isFetchingNextPage, fetchNextPage } =
    useMessages(channelId)
  const {
    sendMessage,
    editingMessageId,
    handleStartEdit,
    handleCancelEdit,
    handleSaveEdit,
    handleDelete,
  } = useMessageActions(channelId, currentUser.id)
  const [messageContent, setMessageContent] = useState('')

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

  /** WHY: Admin+ can always post; others are locked out of read-only channels. */
  const isInputDisabled = isReadOnly && currentUserRole !== 'owner' && currentUserRole !== 'admin'
  const inputPlaceholder = useInputPlaceholder(isInputDisabled, isDm, dmRecipient, channelName)

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
      <ChatToolbar isDm={isDm} dmRecipient={dmRecipient} channelName={channelName} />

      <Divider />

      {/* Virtualized message list */}
      <div
        data-test="message-list"
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto"
      >
        {/* WHY: These elements are OUTSIDE the virtualizer container (normal flow)
            so they don't interfere with absolute-positioned virtual items. */}

        {isFetchingNextPage && (
          <div className="flex justify-center py-2">
            <Spinner size="sm" />
          </div>
        )}

        {!hasNextPage && messages.length > 0 && (
          <div className="px-4 pb-6 pt-4">
            <ChatWelcome
              isDm={isDm}
              dmRecipient={dmRecipient}
              channelName={channelName}
              subtitle={t('channelStart', { channelName: channelName ?? t('channelFallback') })}
            />
            <Divider className="mt-4" />
          </div>
        )}

        {isPending && (
          <div className="flex justify-center py-8">
            <Spinner size="md" />
          </div>
        )}

        {isError && <p className="px-4 text-sm text-danger">{t('failedToLoadMessages')}</p>}

        {messages.length === 0 && isPending === false && isError === false && (
          <div className="px-4 pt-4">
            <ChatWelcome
              isDm={isDm}
              dmRecipient={dmRecipient}
              channelName={channelName}
              subtitle={t('noMessagesYet')}
            />
          </div>
        )}

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
                  canModerateMessages={
                    currentUserRole === 'owner' ||
                    currentUserRole === 'admin' ||
                    currentUserRole === 'moderator'
                  }
                  isEditing={editingMessageId === message.id}
                  onStartEdit={() => handleStartEdit(message.id)}
                  onSaveEdit={(content) => handleSaveEdit(message.id, content)}
                  onCancelEdit={handleCancelEdit}
                  onDelete={() => handleDelete(message.id)}
                />
              </div>
            )
          })}
        </div>
      </div>

      {/* Typing indicator */}
      <TypingIndicator typingUsers={typingUsers} />

      {/* Message input */}
      <MessageInput
        isInputDisabled={isInputDisabled}
        placeholder={inputPlaceholder}
        value={messageContent}
        onValueChange={setMessageContent}
        onKeyDown={handleKeyDown}
        onSendTyping={() => sendTyping(currentUser.username)}
      />
    </div>
  )
}
