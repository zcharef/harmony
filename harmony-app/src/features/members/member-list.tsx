import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { ScrollArea } from '@/components/ui/scroll-area'
import { members } from '@/lib/data'
import { cn } from '@/lib/utils'

const STATUS_COLORS: Record<string, string> = {
  online: 'bg-emerald-500',
  idle: 'bg-amber-400',
  dnd: 'bg-red-500',
  offline: 'bg-zinc-500',
}

function MemberItem({ member }: { member: (typeof members)[number] }) {
  const isOffline = member.status === 'offline'

  return (
    <div
      className={cn(
        'group flex cursor-pointer items-center gap-3 rounded px-2 py-1.5 hover:bg-accent',
        isOffline && 'opacity-40 hover:opacity-100',
      )}
    >
      <div className="relative">
        <Avatar className="h-8 w-8">
          <AvatarFallback className="bg-primary text-xs text-primary-foreground">
            {member.initials}
          </AvatarFallback>
        </Avatar>
        <div
          className={cn(
            'absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-muted',
            STATUS_COLORS[member.status],
          )}
        />
      </div>
      <span className="truncate text-sm font-medium text-muted-foreground group-hover:text-foreground">
        {member.name}
      </span>
    </div>
  )
}

export function MemberList() {
  const grouped = members.reduce<Record<string, typeof members>>((acc, member) => {
    const group = member.status === 'offline' ? 'Offline' : 'Online'
    if (!acc[group]) acc[group] = []
    acc[group].push(member)
    return acc
  }, {})

  return (
    <div className="flex h-full flex-col bg-muted">
      <ScrollArea className="flex-1 px-2">
        <div className="py-6">
          {Object.entries(grouped).map(([group, groupMembers]) => (
            <div key={group} className="mb-4">
              <h3 className="mb-1 px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {group} — {groupMembers.length}
              </h3>
              {groupMembers.map((member) => (
                <MemberItem key={member.id} member={member} />
              ))}
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}
