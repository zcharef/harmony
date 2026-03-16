import { Button, Divider, Spinner, Textarea } from '@heroui/react'
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
import { useState } from 'react'
import { useMessages } from './hooks/use-messages'
import { useRealtimeMessages } from './hooks/use-realtime-messages'
import { useSendMessage } from './hooks/use-send-message'
import { MessageItem } from './message-item'

interface ChatAreaProps {
  channelId: string | null
  channelName: string | null
}

export function ChatArea({ channelId, channelName }: ChatAreaProps) {
  const { data: messageList, isPending, isError } = useMessages(channelId)
  const sendMessage = useSendMessage(channelId ?? '')
  const [messageContent, setMessageContent] = useState('')

  // WHY: Subscribe to realtime inserts so new messages appear instantly
  useRealtimeMessages(channelId ?? '')

  const messages = messageList?.items

  function handleSend() {
    const trimmed = messageContent.trim()
    if (trimmed.length === 0 || channelId === null) return

    sendMessage.mutate(trimmed, {
      onSuccess: () => setMessageContent(''),
    })
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    // WHY: Enter sends, Shift+Enter creates newline (Discord convention)
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

      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        <div className="flex flex-col gap-1 py-4">
          {/* Welcome block */}
          <div className="px-4 pb-6">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-default-100">
              <Hash className="h-10 w-10 text-default-500" />
            </div>
            <h2 className="mt-2 text-3xl font-bold text-foreground">
              Welcome to #{channelName ?? 'channel'}
            </h2>
            <p className="mt-1 text-sm text-default-500">
              This is the start of the #{channelName ?? 'channel'} channel.
            </p>
          </div>

          <Divider className="mx-4 mb-4" />

          {isPending && (
            <div className="flex justify-center py-8">
              <Spinner size="md" />
            </div>
          )}

          {isError && <p className="px-4 text-sm text-danger">Failed to load messages</p>}

          {messages !== undefined && messages.length === 0 && (
            <p className="px-4 text-sm text-default-500">
              No messages yet. Start the conversation!
            </p>
          )}

          {messages?.map((message) => (
            <MessageItem key={message.id} message={message} />
          ))}
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
