import { Button, Divider, Spinner, Textarea } from '@heroui/react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  Bell,
  Hash,
  MessageSquare,
  Pin,
  PlusCircle,
  Search,
  SmilePlus,
  Sticker,
  Users,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMessages } from './hooks/use-messages'
import { useRealtimeMessages } from './hooks/use-realtime-messages'
import { useSendMessage } from './hooks/use-send-message'
import { MessageItem } from './message-item'

interface ChatAreaProps {
  channelId: string | null
  channelName: string | null
}

/**
 * WHY useMemo for flattening: useInfiniteQuery stores pages as an array of
 * arrays. We flatten into a single reversed array (oldest-first for display)
 * so the virtualizer sees one contiguous list. Memoized to avoid re-flattening
 * on every render.
 */
function useFlatMessages(data: ReturnType<typeof useMessages>['data']) {
  return useMemo(() => {
    if (!data) return []
    // WHY: API returns DESC (newest first per page). Reverse so oldest are at top.
    return data.pages.flatMap((page) => page.items).reverse()
  }, [data])
}

export function ChatArea({ channelId, channelName }: ChatAreaProps) {
  const { data, isPending, isError, hasNextPage, isFetchingNextPage, fetchNextPage } =
    useMessages(channelId)
  const sendMessage = useSendMessage(channelId ?? '')
  const [messageContent, setMessageContent] = useState('')

  useRealtimeMessages(channelId ?? '')

  const messages = useFlatMessages(data)
  const scrollRef = useRef<HTMLDivElement>(null)
  const prevMessageCountRef = useRef(0)

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 52, // WHY: Estimated row height in px — virtualizer adjusts after measure
    overscan: 10, // WHY: Pre-render 10 items above/below viewport for smooth scrolling
  })

  // WHY: Auto-scroll to bottom when new messages arrive (not when loading old pages)
  useEffect(() => {
    const prevCount = prevMessageCountRef.current
    const currentCount = messages.length

    if (currentCount > prevCount && prevCount > 0) {
      // WHY: Only auto-scroll if user was already near the bottom (within 200px)
      const el = scrollRef.current
      if (el) {
        const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
        if (distanceFromBottom < 200) {
          virtualizer.scrollToIndex(currentCount - 1, { align: 'end' })
        }
      }
    }

    prevMessageCountRef.current = currentCount
  }, [messages.length, virtualizer])

  // WHY: Scroll to bottom on initial load
  useEffect(() => {
    if (messages.length > 0 && prevMessageCountRef.current === 0) {
      virtualizer.scrollToIndex(messages.length - 1, { align: 'end' })
    }
  }, [messages.length, virtualizer])

  // WHY: Fetch older messages when user scrolls near the top
  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    // WHY: 200px threshold gives time to fetch before hitting the top
    if (el.scrollTop < 200 && hasNextPage && !isFetchingNextPage) {
      fetchNextPage()
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])

  function handleSend() {
    const trimmed = messageContent.trim()
    if (trimmed.length === 0 || channelId === null) return

    sendMessage.mutate(trimmed, {
      onSuccess: () => setMessageContent(''),
    })
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  if (channelId === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-background">
        <Hash className="h-16 w-16 text-default-300" />
        <p className="mt-2 text-default-500">Select a channel to start chatting</p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Channel header */}
      <div className="flex h-12 items-center justify-between border-b border-divider px-4 shadow-sm">
        <div className="flex items-center gap-2">
          <Hash className="h-5 w-5 text-default-500" />
          <span className="font-semibold text-foreground">{channelName ?? 'channel'}</span>
        </div>
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
          <Button variant="light" isIconOnly size="sm">
            <Users className="h-5 w-5 text-default-500" />
          </Button>
          <div className="ml-2 flex h-6 items-center rounded bg-default-100 px-1.5">
            <Search className="h-4 w-4 text-default-500" />
            <span className="ml-1 text-xs text-default-500">Search</span>
          </div>
        </div>
      </div>

      <Divider />

      {/* Virtualized message list */}
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto">
        {/* WHY: relative container with dynamic height lets the virtualizer control scroll space */}
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {/* Loading older messages indicator */}
          {isFetchingNextPage && (
            <div className="flex justify-center py-2">
              <Spinner size="sm" />
            </div>
          )}

          {/* Welcome block — only when we've loaded all history */}
          {!hasNextPage && messages.length > 0 && (
            <div className="px-4 pb-6 pt-4">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-default-100">
                <Hash className="h-10 w-10 text-default-500" />
              </div>
              <h2 className="mt-2 text-3xl font-bold text-foreground">
                Welcome to #{channelName ?? 'channel'}
              </h2>
              <p className="mt-1 text-sm text-default-500">
                This is the start of the #{channelName ?? 'channel'} channel.
              </p>
              <Divider className="mt-4" />
            </div>
          )}

          {isPending && (
            <div className="flex justify-center py-8">
              <Spinner size="md" />
            </div>
          )}

          {isError && <p className="px-4 text-sm text-danger">Failed to load messages</p>}

          {messages.length === 0 && !isPending && !isError && (
            <div className="px-4 pt-4">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-default-100">
                <Hash className="h-10 w-10 text-default-500" />
              </div>
              <h2 className="mt-2 text-3xl font-bold text-foreground">
                Welcome to #{channelName ?? 'channel'}
              </h2>
              <p className="mt-1 text-sm text-default-500">
                No messages yet. Start the conversation!
              </p>
            </div>
          )}

          {/* WHY: virtualItems are only the visible rows — this is the performance win */}
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
                <MessageItem message={message} />
              </div>
            )
          })}
        </div>
      </div>

      {/* Message input */}
      <div className="px-4 pb-6 pt-1">
        <div className="relative flex items-center rounded-lg bg-default-100">
          <Button variant="light" isIconOnly size="sm" className="ml-1 shrink-0">
            <PlusCircle className="h-5 w-5 text-default-500" />
          </Button>
          <Textarea
            placeholder={`Message #${channelName ?? 'channel'}`}
            variant="flat"
            minRows={1}
            maxRows={6}
            value={messageContent}
            onValueChange={setMessageContent}
            onKeyDown={handleKeyDown}
            classNames={{
              base: 'flex-1',
              inputWrapper: 'border-0 bg-transparent shadow-none',
              input: 'text-sm text-foreground placeholder:text-default-500 px-2 py-3',
            }}
          />
          <div className="flex shrink-0 items-center gap-0.5 pr-2">
            <Button variant="light" isIconOnly size="sm">
              <Sticker className="h-5 w-5 text-default-500" />
            </Button>
            <Button variant="light" isIconOnly size="sm">
              <SmilePlus className="h-5 w-5 text-default-500" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
