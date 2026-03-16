import { Avatar, Divider, Tooltip } from '@heroui/react'
import { Plus } from 'lucide-react'
import { servers } from '@/lib/data'
import { cn } from '@/lib/utils'

const ACTIVE_SERVER_ID = '1'

function ServerIcon({
  server,
  isActive,
  isHome,
}: {
  server: (typeof servers)[number]
  isActive: boolean
  isHome?: boolean
}) {
  return (
    <Tooltip content={server.name} placement="right" offset={8}>
      <div className="relative flex items-center justify-center w-full group">
        {/* Active pill indicator */}
        <div
          className={cn(
            'absolute left-0 w-1 rounded-r-full bg-foreground transition-all duration-200',
            isActive ? 'h-10' : 'h-0 group-hover:h-5',
          )}
        />

        <Avatar
          name={server.initials}
          classNames={{
            base: cn(
              'h-12 w-12 cursor-pointer transition-all duration-200',
              isActive
                ? 'rounded-2xl bg-primary text-primary-foreground'
                : 'rounded-[24px] hover:rounded-2xl bg-default-100 text-default-foreground hover:bg-primary hover:text-primary-foreground',
              isHome && !isActive && 'hover:bg-primary',
            ),
            name: cn(
              'text-sm font-medium transition-all duration-200',
              isActive
                ? 'text-primary-foreground'
                : 'text-default-foreground group-hover:text-primary-foreground',
            ),
          }}
        />
      </div>
    </Tooltip>
  )
}

export function ServerList() {
  const [home, ...rest] = servers
  if (!home) return null

  return (
    <div className="flex h-full w-[72px] flex-col items-center bg-content1 py-3">
      {/* Home / DMs */}
      <ServerIcon server={home} isActive={false} isHome />

      <Divider className="mx-auto my-2 w-8 bg-divider" />

      {/* Server list */}
      <div className="flex-1 w-full overflow-y-auto">
        <div className="flex flex-col items-center gap-2">
          {rest.map((server) => (
            <ServerIcon key={server.id} server={server} isActive={server.id === ACTIVE_SERVER_ID} />
          ))}
        </div>
      </div>

      <Divider className="mx-auto my-2 w-8 bg-divider" />

      {/* Add server button */}
      <Tooltip content="Add a Server" placement="right" offset={8}>
        <div className="flex items-center justify-center">
          <Avatar
            icon={<Plus className="h-5 w-5" />}
            classNames={{
              base: cn(
                'h-12 w-12 cursor-pointer rounded-[24px] bg-default-100 text-default-foreground',
                'transition-all duration-200 hover:rounded-2xl hover:bg-success hover:text-success-foreground',
              ),
              icon: 'text-current',
            }}
          />
        </div>
      </Tooltip>
    </div>
  )
}
