import { Plus } from 'lucide-react'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
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
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="relative flex items-center justify-center w-full group">
          {/* Active pill indicator */}
          <div
            className={cn(
              'absolute left-0 w-1 rounded-r-full bg-foreground transition-all duration-200',
              isActive ? 'h-10' : 'h-0 group-hover:h-5',
            )}
          />

          <Avatar
            className={cn(
              'h-12 w-12 cursor-pointer transition-all duration-200',
              isActive
                ? 'rounded-2xl bg-primary text-primary-foreground'
                : 'rounded-[24px] hover:rounded-2xl bg-secondary text-secondary-foreground hover:bg-primary hover:text-primary-foreground',
              isHome && !isActive && 'hover:bg-primary',
            )}
          >
            <AvatarFallback
              className={cn(
                'text-sm font-medium transition-all duration-200 bg-transparent',
                isActive
                  ? 'text-primary-foreground'
                  : 'text-secondary-foreground group-hover:text-primary-foreground',
              )}
            >
              {server.initials}
            </AvatarFallback>
          </Avatar>
        </div>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        <p>{server.name}</p>
      </TooltipContent>
    </Tooltip>
  )
}

export function ServerList() {
  const [home, ...rest] = servers
  if (!home) return null

  return (
    <TooltipProvider delayDuration={0}>
      <div className="flex h-full w-[72px] flex-col items-center bg-card py-3">
        {/* Home / DMs */}
        <ServerIcon server={home} isActive={false} isHome />

        <Separator className="mx-auto my-2 w-8 bg-border" />

        {/* Server list */}
        <ScrollArea className="flex-1 w-full">
          <div className="flex flex-col items-center gap-2">
            {rest.map((server) => (
              <ServerIcon
                key={server.id}
                server={server}
                isActive={server.id === ACTIVE_SERVER_ID}
              />
            ))}
          </div>
        </ScrollArea>

        <Separator className="mx-auto my-2 w-8 bg-border" />

        {/* Add server button */}
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center justify-center">
              <Avatar className="h-12 w-12 cursor-pointer rounded-[24px] bg-secondary text-secondary-foreground transition-all duration-200 hover:rounded-2xl hover:bg-emerald-600 hover:text-white">
                <AvatarFallback className="bg-transparent">
                  <Plus className="h-5 w-5" />
                </AvatarFallback>
              </Avatar>
            </div>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8}>
            <p>Add a Server</p>
          </TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  )
}
