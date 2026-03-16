import { Avatar } from '@heroui/react'
import type { Message } from '@/lib/data'

export function MessageItem({ message }: { message: Message }) {
  return (
    <div className="group flex gap-4 px-4 py-1 hover:bg-default-200/50">
      <Avatar
        name={message.authorName}
        color="primary"
        size="md"
        classNames={{
          base: 'mt-0.5 h-10 w-10 shrink-0',
          name: 'text-sm',
        }}
      />
      <div className="flex min-w-0 flex-col">
        <div className="flex items-baseline gap-2">
          <span className="cursor-pointer font-medium text-foreground hover:underline">
            {message.authorName}
          </span>
          <span className="text-xs text-default-500">{message.timestamp}</span>
        </div>
        <p className="text-sm text-foreground/90">{message.content}</p>
      </div>
    </div>
  )
}
