import { GripVertical } from 'lucide-react'
import { Group, Panel, Separator } from 'react-resizable-panels'

import { ChannelSidebar } from '@/features/channels'
import { ChatArea } from '@/features/chat'
import { MemberList } from '@/features/members'
import { ServerList } from '@/features/server-nav'

function ResizeHandle() {
  return (
    <Separator className="relative flex w-px items-center justify-center bg-divider after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary focus-visible:ring-offset-1">
      <div className="z-10 flex h-4 w-3 items-center justify-center rounded-sm border bg-divider">
        <GripVertical className="h-2.5 w-2.5" />
      </div>
    </Separator>
  )
}

export function MainLayout() {
  return (
    <div className="flex h-screen w-screen overflow-hidden">
      {/* Server nav - fixed width, outside resizable group */}
      <ServerList />

      {/* Resizable panels for sidebar, chat, members */}
      <Group orientation="horizontal" className="flex h-full w-full flex-1">
        <Panel defaultSize="20%" minSize="15%" maxSize="30%">
          <ChannelSidebar />
        </Panel>

        <ResizeHandle />

        <Panel defaultSize="60%" minSize="30%">
          <ChatArea />
        </Panel>

        <ResizeHandle />

        <Panel defaultSize="20%" minSize="15%" maxSize="25%" collapsible collapsedSize="0%">
          <MemberList />
        </Panel>
      </Group>
    </div>
  )
}
