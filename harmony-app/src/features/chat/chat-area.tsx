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
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Textarea } from '@/components/ui/textarea'
import { messages } from '@/lib/data'
import { MessageItem } from './message-item'

export function ChatArea() {
  return (
    <div className="flex h-full flex-col bg-background">
      {/* Channel header */}
      <div className="flex h-12 items-center justify-between border-b border-border px-4 shadow-sm">
        <div className="flex items-center gap-2">
          <Hash className="h-5 w-5 text-muted-foreground" />
          <span className="font-semibold text-foreground">general</span>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <MessageSquare className="h-5 w-5 text-muted-foreground" />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <Bell className="h-5 w-5 text-muted-foreground" />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <Pin className="h-5 w-5 text-muted-foreground" />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <Users className="h-5 w-5 text-muted-foreground" />
          </Button>
          <div className="ml-2 flex h-6 items-center rounded bg-secondary px-1.5">
            <Search className="h-4 w-4 text-muted-foreground" />
            <span className="ml-1 text-xs text-muted-foreground">Search</span>
          </div>
        </div>
      </div>

      <Separator />

      {/* Messages */}
      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-1 py-4">
          {/* Welcome block */}
          <div className="px-4 pb-6">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-secondary">
              <Hash className="h-10 w-10 text-muted-foreground" />
            </div>
            <h2 className="mt-2 text-3xl font-bold text-foreground">Welcome to #general</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              This is the start of the #general channel.
            </p>
          </div>

          <Separator className="mx-4 mb-4" />

          {messages.map((message) => (
            <MessageItem key={message.id} message={message} />
          ))}
        </div>
      </ScrollArea>

      {/* Message input */}
      <div className="px-4 pb-6 pt-1">
        <div className="relative flex items-center rounded-lg bg-muted">
          <Button variant="ghost" size="icon" className="ml-1 h-8 w-8 shrink-0">
            <PlusCircle className="h-5 w-5 text-muted-foreground" />
          </Button>
          <Textarea
            placeholder="Message #general"
            className="min-h-[44px] max-h-[200px] resize-none border-0 bg-transparent px-2 py-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:ring-0 focus-visible:ring-offset-0"
            rows={1}
          />
          <div className="flex shrink-0 items-center gap-0.5 pr-2">
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <Sticker className="h-5 w-5 text-muted-foreground" />
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <SmilePlus className="h-5 w-5 text-muted-foreground" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
