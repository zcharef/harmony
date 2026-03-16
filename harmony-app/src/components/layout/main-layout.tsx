import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { ChannelSidebar } from '@/features/channels'
import { ChatArea } from '@/features/chat'
import { MemberList } from '@/features/members'
import { ServerList } from '@/features/server-nav'

export function MainLayout() {
  return (
    <div className="flex h-screen w-screen overflow-hidden">
      {/* Server nav - fixed width, outside resizable group */}
      <ServerList />

      {/* Resizable panels for sidebar, chat, members */}
      <ResizablePanelGroup orientation="horizontal" className="flex-1">
        <ResizablePanel defaultSize="20%" minSize="15%" maxSize="30%">
          <ChannelSidebar />
        </ResizablePanel>

        <ResizableHandle withHandle />

        <ResizablePanel defaultSize="60%" minSize="30%">
          <ChatArea />
        </ResizablePanel>

        <ResizableHandle withHandle />

        <ResizablePanel
          defaultSize="20%"
          minSize="15%"
          maxSize="25%"
          collapsible
          collapsedSize="0%"
        >
          <MemberList />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}
