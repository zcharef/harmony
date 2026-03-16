import { ChevronDown, Hash, Headphones, Mic, Plus, Settings, Volume2 } from 'lucide-react'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ScrollArea } from '@/components/ui/scroll-area'
import { channelCategories, currentUser } from '@/lib/data'
import { cn } from '@/lib/utils'

const ACTIVE_CHANNEL_ID = 'ch-1'

export function ChannelSidebar() {
  return (
    <div className="flex h-full flex-col bg-muted">
      {/* Server header */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex h-12 w-full items-center justify-between border-b border-border px-4 font-semibold text-foreground shadow-sm transition-colors hover:bg-accent"
          >
            <span className="truncate">Tailwind CSS</span>
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-56" align="start">
          <DropdownMenuItem>Server Boost</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem>Invite People</DropdownMenuItem>
          <DropdownMenuItem>Server Settings</DropdownMenuItem>
          <DropdownMenuItem>Create Channel</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-destructive">Leave Server</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Channel list */}
      <ScrollArea className="flex-1 px-2">
        <div className="py-3">
          {channelCategories.map((category) => (
            <Collapsible key={category.id} defaultOpen>
              <CollapsibleTrigger className="group flex w-full items-center gap-0.5 px-1 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground">
                <ChevronDown className="h-3 w-3 shrink-0 transition-transform group-data-[state=closed]:-rotate-90" />
                <span>{category.name}</span>
                <button
                  type="button"
                  className="ml-auto opacity-0 group-hover:opacity-100"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Plus className="h-4 w-4 text-muted-foreground hover:text-foreground" />
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                {category.channels.map((channel) => (
                  <Button
                    key={channel.id}
                    variant="ghost"
                    size="sm"
                    className={cn(
                      'w-full justify-start gap-1.5 px-2 font-medium text-muted-foreground',
                      channel.id === ACTIVE_CHANNEL_ID && 'bg-accent text-foreground',
                    )}
                  >
                    {channel.type === 'text' ? (
                      <Hash className="h-4 w-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <Volume2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="truncate">{channel.name}</span>
                  </Button>
                ))}
              </CollapsibleContent>
            </Collapsible>
          ))}
        </div>
      </ScrollArea>

      {/* User control panel */}
      <div className="flex items-center gap-2 border-t border-border bg-card p-2">
        <div className="relative">
          <Avatar className="h-8 w-8">
            <AvatarFallback className="bg-primary text-xs text-primary-foreground">
              {currentUser.initials}
            </AvatarFallback>
          </Avatar>
          <div className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-card bg-emerald-500" />
        </div>
        <div className="flex flex-1 flex-col overflow-hidden">
          <span className="truncate text-sm font-medium text-foreground">{currentUser.name}</span>
          <span className="truncate text-xs text-muted-foreground">
            {currentUser.discriminator}
          </span>
        </div>
        <div className="flex items-center">
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <Mic className="h-4 w-4 text-muted-foreground" />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <Headphones className="h-4 w-4 text-muted-foreground" />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <Settings className="h-4 w-4 text-muted-foreground" />
          </Button>
        </div>
      </div>
    </div>
  )
}
