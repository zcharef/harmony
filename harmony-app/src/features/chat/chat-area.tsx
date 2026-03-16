import { Button, Divider, Textarea } from '@heroui/react'
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
import { messages } from '@/lib/data'
import { MessageItem } from './message-item'

export function ChatArea() {
  return (
    <div className="flex h-full flex-col bg-background">
      {/* Channel header */}
      <div className="flex h-12 items-center justify-between border-b border-divider px-4 shadow-sm">
        <div className="flex items-center gap-2">
          <Hash className="h-5 w-5 text-default-500" />
          <span className="font-semibold text-foreground">general</span>
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
            <h2 className="mt-2 text-3xl font-bold text-foreground">Welcome to #general</h2>
            <p className="mt-1 text-sm text-default-500">
              This is the start of the #general channel.
            </p>
          </div>

          <Divider className="mx-4 mb-4" />

          {messages.map((message) => (
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
            placeholder="Message #general"
            variant="flat"
            minRows={1}
            maxRows={6}
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
