import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import type { Message } from '@/lib/data'

export function MessageItem({ message }: { message: Message }) {
  return (
    <div className="group flex gap-4 px-4 py-1 hover:bg-accent/50">
      <Avatar className="mt-0.5 h-10 w-10 shrink-0">
        <AvatarFallback className="bg-primary text-sm text-primary-foreground">
          {message.authorInitials}
        </AvatarFallback>
      </Avatar>
      <div className="flex min-w-0 flex-col">
        <div className="flex items-baseline gap-2">
          <span className="font-medium text-foreground hover:underline cursor-pointer">
            {message.authorName}
          </span>
          <span className="text-xs text-muted-foreground">{message.timestamp}</span>
        </div>
        <p className="text-sm text-foreground/90">{message.content}</p>
      </div>
    </div>
  )
}
