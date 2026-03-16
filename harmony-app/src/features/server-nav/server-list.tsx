import { Avatar, Divider, Spinner, Tooltip } from '@heroui/react'
import { LogIn, Plus } from 'lucide-react'
import { useState } from 'react'
import type { ServerResponse } from '@/lib/api'
import { cn } from '@/lib/utils'
import { CreateServerDialog } from './create-server-dialog'
import { useServers } from './hooks/use-servers'
import { JoinServerDialog } from './join-server-dialog'

function ServerIcon({
  server,
  isActive,
  onSelect,
}: {
  server: ServerResponse
  isActive: boolean
  onSelect: () => void
}) {
  // WHY: Generate initials from server name for avatar fallback
  const initials = server.name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()

  return (
    <Tooltip content={server.name} placement="right" offset={8}>
      <button
        data-test="server-button"
        data-server-id={server.id}
        type="button"
        onClick={onSelect}
        className="relative flex w-full items-center justify-center group"
      >
        {/* Active pill indicator */}
        <div
          className={cn(
            'absolute left-0 w-1 rounded-r-full bg-foreground transition-all duration-200',
            isActive ? 'h-10' : 'h-0 group-hover:h-5',
          )}
        />

        <Avatar
          name={initials}
          src={server.iconUrl ?? undefined}
          classNames={{
            base: cn(
              'h-12 w-12 cursor-pointer transition-all duration-200',
              isActive
                ? 'rounded-2xl bg-primary text-primary-foreground'
                : 'rounded-[24px] hover:rounded-2xl bg-default-100 text-default-foreground hover:bg-primary hover:text-primary-foreground',
            ),
            name: cn(
              'text-sm font-medium transition-all duration-200',
              isActive
                ? 'text-primary-foreground'
                : 'text-default-foreground group-hover:text-primary-foreground',
            ),
          }}
        />
      </button>
    </Tooltip>
  )
}

interface ServerListProps {
  selectedServerId: string | null
  onSelectServer: (serverId: string) => void
}

export function ServerList({ selectedServerId, onSelectServer }: ServerListProps) {
  const { data: servers, isPending, isError } = useServers()
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [isJoinOpen, setIsJoinOpen] = useState(false)

  if (isPending) {
    return (
      <div className="flex h-full w-[72px] flex-col items-center justify-center bg-content1">
        <Spinner size="sm" />
      </div>
    )
  }

  if (isError) {
    return (
      <div className="flex h-full w-[72px] flex-col items-center justify-center bg-content1">
        <span className="text-xs text-danger">Error</span>
      </div>
    )
  }

  // WHY: Separate DM servers from regular servers for Discord-like layout
  const dmServers = servers?.filter((s) => s.isDm) ?? []
  const regularServers = servers?.filter((s) => !s.isDm) ?? []
  const homeServer = dmServers[0]

  return (
    <div data-test="server-list" className="flex h-full w-[72px] flex-col items-center bg-content1 py-3">
      {/* Home / DMs */}
      {homeServer !== undefined && (
        <ServerIcon
          server={homeServer}
          isActive={selectedServerId === homeServer.id}
          onSelect={() => onSelectServer(homeServer.id)}
        />
      )}

      <Divider className="mx-auto my-2 w-8 bg-divider" />

      {/* Server list */}
      <div className="w-full flex-1 overflow-y-auto">
        <div className="flex flex-col items-center gap-2">
          {regularServers.map((server) => (
            <ServerIcon
              key={server.id}
              server={server}
              isActive={server.id === selectedServerId}
              onSelect={() => onSelectServer(server.id)}
            />
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
            onClick={() => setIsCreateOpen(true)}
          />
        </div>
      </Tooltip>

      {/* Join server button */}
      <Tooltip content="Join a Server" placement="right" offset={8}>
        <div className="mt-2 flex items-center justify-center">
          <Avatar
            icon={<LogIn className="h-5 w-5" />}
            classNames={{
              base: cn(
                'h-12 w-12 cursor-pointer rounded-[24px] bg-default-100 text-default-foreground',
                'transition-all duration-200 hover:rounded-2xl hover:bg-primary hover:text-primary-foreground',
              ),
              icon: 'text-current',
            }}
            onClick={() => setIsJoinOpen(true)}
          />
        </div>
      </Tooltip>

      <CreateServerDialog
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        onCreated={(serverId) => onSelectServer(serverId)}
      />

      <JoinServerDialog
        isOpen={isJoinOpen}
        onClose={() => setIsJoinOpen(false)}
        onJoined={() => {}}
      />
    </div>
  )
}
