interface TypingUser {
  userId: string
  username: string
}

interface TypingIndicatorProps {
  typingUsers: TypingUser[]
}

/**
 * WHY separate component: Isolates re-renders from typing state changes
 * to this small DOM subtree, avoiding re-rendering the entire chat area
 * and virtualized message list on every typing event.
 */
export function TypingIndicator({ typingUsers }: TypingIndicatorProps) {
  if (typingUsers.length === 0) return null

  const first = typingUsers[0]
  const second = typingUsers[1]

  const text =
    typingUsers.length === 1 && first !== undefined
      ? `${first.username} is typing`
      : typingUsers.length === 2 && first !== undefined && second !== undefined
        ? `${first.username} and ${second.username} are typing`
        : 'Several people are typing'

  return (
    <div className="flex h-6 items-center gap-1 px-4 text-xs text-default-500">
      <BouncingDots />
      <span>{text}</span>
    </div>
  )
}

/**
 * WHY CSS animation over JS: Three dots with staggered bounce delays.
 * Pure CSS is cheaper than JS timers and doesn't block the main thread.
 * Uses Tailwind animate-bounce with inline animation-delay for stagger.
 */
function BouncingDots() {
  return (
    <span className="inline-flex items-center gap-0.5" aria-hidden="true">
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-default-500 [animation-delay:0ms]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-default-500 [animation-delay:150ms]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-default-500 [animation-delay:300ms]" />
    </span>
  )
}
