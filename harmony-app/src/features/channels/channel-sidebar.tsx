import {
  Accordion,
  AccordionItem,
  Avatar,
  Button,
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownSection,
  DropdownTrigger,
} from '@heroui/react'
import { ChevronDown, Hash, Headphones, Mic, Plus, Settings, Volume2 } from 'lucide-react'
import { channelCategories, currentUser } from '@/lib/data'
import { cn } from '@/lib/utils'

const ACTIVE_CHANNEL_ID = 'ch-1'

export function ChannelSidebar() {
  return (
    <div className="flex h-full flex-col bg-default-100">
      {/* Server header */}
      <Dropdown>
        <DropdownTrigger>
          <button
            type="button"
            className="flex h-12 w-full items-center justify-between border-b border-divider px-4 font-semibold text-foreground shadow-sm transition-colors hover:bg-default-200"
          >
            <span className="truncate">Tailwind CSS</span>
            <ChevronDown className="h-4 w-4 shrink-0 text-default-500" />
          </button>
        </DropdownTrigger>
        <DropdownMenu aria-label="Server options" className="w-56">
          <DropdownSection showDivider>
            <DropdownItem key="boost">Server Boost</DropdownItem>
          </DropdownSection>
          <DropdownSection showDivider>
            <DropdownItem key="invite">Invite People</DropdownItem>
            <DropdownItem key="settings">Server Settings</DropdownItem>
            <DropdownItem key="create-channel">Create Channel</DropdownItem>
          </DropdownSection>
          <DropdownSection>
            <DropdownItem key="leave" className="text-danger" color="danger">
              Leave Server
            </DropdownItem>
          </DropdownSection>
        </DropdownMenu>
      </Dropdown>

      {/* Channel list */}
      <div className="flex-1 overflow-y-auto px-2">
        <div className="py-3">
          <Accordion
            selectionMode="multiple"
            defaultExpandedKeys={channelCategories.map((c) => c.id)}
            showDivider={false}
            hideIndicator
            isCompact
            className="px-0"
            itemClasses={{
              base: 'py-0',
              trigger: 'py-0',
              title: 'text-xs font-semibold uppercase tracking-wide',
              content: 'pb-0 pt-0',
            }}
          >
            {channelCategories.map((category) => (
              <AccordionItem
                key={category.id}
                aria-label={category.name}
                title={
                  <div className="group flex w-full items-center gap-0.5">
                    <ChevronDown className="h-3 w-3 shrink-0 text-default-500 transition-transform group-data-[open=true]:rotate-0 -rotate-90 group-data-[open]:rotate-0" />
                    <span className="text-default-500 group-hover:text-foreground">
                      {category.name}
                    </span>
                    <button
                      type="button"
                      className="ml-auto opacity-0 group-hover:opacity-100"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Plus className="h-4 w-4 text-default-500 hover:text-foreground" />
                    </button>
                  </div>
                }
              >
                {category.channels.map((channel) => (
                  <Button
                    key={channel.id}
                    variant="light"
                    size="sm"
                    className={cn(
                      'w-full justify-start gap-1.5 px-2 font-medium text-default-500',
                      channel.id === ACTIVE_CHANNEL_ID && 'bg-default-200 text-foreground',
                    )}
                  >
                    {channel.type === 'text' ? (
                      <Hash className="h-4 w-4 shrink-0 text-default-500" />
                    ) : (
                      <Volume2 className="h-4 w-4 shrink-0 text-default-500" />
                    )}
                    <span className="truncate">{channel.name}</span>
                  </Button>
                ))}
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </div>

      {/* User control panel */}
      <div className="flex items-center gap-2 border-t border-divider bg-content1 p-2">
        <div className="relative">
          <Avatar
            name={currentUser.initials}
            size="sm"
            color="primary"
            showFallback
            classNames={{
              base: 'h-8 w-8',
              name: 'text-xs text-primary-foreground',
            }}
          />
          <div className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-content1 bg-success" />
        </div>
        <div className="flex flex-1 flex-col overflow-hidden">
          <span className="truncate text-sm font-medium text-foreground">{currentUser.name}</span>
          <span className="truncate text-xs text-default-500">{currentUser.discriminator}</span>
        </div>
        <div className="flex items-center">
          <Button variant="light" isIconOnly size="sm" className="h-8 w-8">
            <Mic className="h-4 w-4 text-default-500" />
          </Button>
          <Button variant="light" isIconOnly size="sm" className="h-8 w-8">
            <Headphones className="h-4 w-4 text-default-500" />
          </Button>
          <Button variant="light" isIconOnly size="sm" className="h-8 w-8">
            <Settings className="h-4 w-4 text-default-500" />
          </Button>
        </div>
      </div>
    </div>
  )
}
