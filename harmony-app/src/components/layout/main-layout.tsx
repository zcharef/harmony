import { GripVertical } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'

import { useAuthStore } from '@/features/auth'
import { ChannelSidebar, useChannels } from '@/features/channels'
import { ChatArea } from '@/features/chat'
import { MemberList } from '@/features/members'
import { usePresence } from '@/features/presence'
import { ServerList, useServers } from '@/features/server-nav'

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
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null)
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null)

  // WHY: Derive server/channel names from query cache to display in headers.
  // This avoids passing full objects between features (CLAUDE.md 4.5: pass IDs, not objects).
  const { data: servers } = useServers()

  // WHY: Presence subscribes to ALL servers so the user appears online to
  // friends everywhere, not just on the currently viewed server.
  const userId = useAuthStore((s) => s.user?.id ?? null)
  const serverIds = useMemo(() => servers?.map((s) => s.id) ?? [], [servers])
  usePresence(serverIds, selectedServerId, userId)
  const { data: channels } = useChannels(selectedServerId)

  const selectedServer = servers?.find((s) => s.id === selectedServerId)
  const selectedChannel = channels?.find((c) => c.id === selectedChannelId)

  function handleSelectServer(serverId: string) {
    setSelectedServerId(serverId)
    // WHY: Reset channel selection when switching servers
    setSelectedChannelId(null)
  }

  return (
    <div data-test="main-layout" className="flex h-screen w-screen overflow-hidden">
      {/* Server nav - fixed width, outside resizable group */}
      <ServerList selectedServerId={selectedServerId} onSelectServer={handleSelectServer} />

      {/* Resizable panels for sidebar, chat, members */}
      <Group orientation="horizontal" className="flex h-full w-full flex-1">
        <Panel defaultSize="20%" minSize="15%" maxSize="30%">
          <ChannelSidebar
            serverId={selectedServerId}
            serverName={selectedServer?.name ?? null}
            selectedChannelId={selectedChannelId}
            onSelectChannel={setSelectedChannelId}
          />
        </Panel>

        <ResizeHandle />

        <Panel defaultSize="60%" minSize="30%">
          <ChatArea channelId={selectedChannelId} channelName={selectedChannel?.name ?? null} />
        </Panel>

        <ResizeHandle />

        <Panel defaultSize="20%" minSize="15%" maxSize="25%" collapsible collapsedSize="0%">
          <MemberList serverId={selectedServerId} />
        </Panel>
      </Group>
    </div>
  )
}
