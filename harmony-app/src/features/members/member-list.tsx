import { Avatar } from '@heroui/react'
import { members } from '@/lib/data'
import { cn } from '@/lib/utils'

const STATUS_COLORS: Record<string, string> = {
  online: 'bg-success',
  idle: 'bg-warning',
  dnd: 'bg-danger',
  offline: 'bg-default-400',
}

function MemberItem({ member }: { member: (typeof members)[number] }) {
  const isOffline = member.status === 'offline'

  return (
    <div
      className={cn(
        'group flex cursor-pointer items-center gap-3 rounded px-2 py-1.5 hover:bg-default-200',
        isOffline && 'opacity-40 hover:opacity-100',
      )}
    >
      <div className="relative">
        <Avatar
          name={member.name}
          color="primary"
          size="sm"
          classNames={{
            base: 'h-8 w-8',
            name: 'text-xs',
          }}
        />
        <div
          className={cn(
            'absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-default',
            STATUS_COLORS[member.status],
          )}
        />
      </div>
      <span className="truncate text-sm font-medium text-default-500 group-hover:text-foreground">
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
    <div className="flex h-full flex-col bg-default-100">
      <div className="flex-1 overflow-y-auto px-2">
        <div className="py-6">
          {Object.entries(grouped).map(([group, groupMembers]) => (
            <div key={group} className="mb-4">
              <h3 className="mb-1 px-2 text-xs font-semibold uppercase tracking-wide text-default-500">
                {group} — {groupMembers.length}
              </h3>
              {groupMembers.map((member) => (
                <MemberItem key={member.id} member={member} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
