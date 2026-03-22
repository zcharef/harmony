import { GripVertical } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'

import { useAuthStore } from '@/features/auth'
import { ChannelSidebar, useChannels } from '@/features/channels'
import { ChatArea } from '@/features/chat'
import { DmSidebar, useDms } from '@/features/dms'
import { MemberList, useMyMemberRole } from '@/features/members'
import { usePresence } from '@/features/presence'
import { ServerList, useServers } from '@/features/server-nav'
import { getChannelPerms, ServerSettings, useSettingsUiStore } from '@/features/settings'

type ViewMode = 'servers' | 'dms'

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
  const [view, setView] = useState<ViewMode>('servers')
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

  // WHY: DM list needed to derive chat header info (recipient name) when in DM view
  const { data: dms } = useDms()

  const selectedServer = servers?.find((s) => s.id === selectedServerId)
  const selectedChannel = channels?.find((c) => c.id === selectedChannelId)
  const { role: currentUserRole } = useMyMemberRole(selectedServerId)

  // WHY: When in DM view, derive the chat header name from the DM recipient
  // rather than from the channel name (which would show "dm" or similar).
  const activeDm = view === 'dms' ? dms?.find((dm) => dm.serverId === selectedServerId) : undefined

  const chatHeaderName =
    view === 'dms' && activeDm !== undefined
      ? (activeDm.recipient.displayName ?? activeDm.recipient.username)
      : (selectedChannel?.name ?? null)

  const handleSelectServer = useCallback((serverId: string) => {
    setView('servers')
    setSelectedServerId(serverId)
    // WHY: Reset channel selection when switching servers
    setSelectedChannelId(null)
  }, [])

  const handleSelectDmView = useCallback(() => {
    setView('dms')
    setSelectedServerId(null)
    setSelectedChannelId(null)
  }, [])

  const handleSelectDm = useCallback((serverId: string, channelId: string) => {
    setSelectedServerId(serverId)
    setSelectedChannelId(channelId)
  }, [])

  const isDmView = view === 'dms'
  const showServerSettings = useSettingsUiStore((s) => s.showServerSettings)

  /** WHY: Server settings replaces the entire main content area (like Discord). */
  if (showServerSettings && selectedServerId !== null) {
    return (
      <div data-test="main-layout" className="flex h-screen w-screen overflow-hidden">
        <ServerSettings serverId={selectedServerId} />
      </div>
    )
  }

  return (
    <div data-test="main-layout" className="flex h-screen w-screen overflow-hidden">
      {/* Server nav - fixed width, outside resizable group */}
      <ServerList
        selectedServerId={selectedServerId}
        view={view}
        onSelectServer={handleSelectServer}
        onSelectDmView={handleSelectDmView}
      />

      {/* Resizable panels for sidebar, chat, members */}
      <Group orientation="horizontal" className="flex h-full w-full flex-1">
        <Panel defaultSize="20%" minSize="15%" maxSize="30%">
          {isDmView ? (
            <DmSidebar selectedServerId={selectedServerId} onSelectDm={handleSelectDm} />
          ) : (
            <ChannelSidebar
              serverId={selectedServerId}
              serverName={selectedServer?.name ?? null}
              selectedChannelId={selectedChannelId}
              onSelectChannel={setSelectedChannelId}
            />
          )}
        </Panel>

        <ResizeHandle />

        <Panel defaultSize={isDmView ? '80%' : '60%'} minSize="30%">
          <ChatArea
            channelId={selectedChannelId}
            channelName={chatHeaderName}
            currentUserRole={currentUserRole}
            isDm={isDmView && selectedChannelId !== null}
            dmRecipient={activeDm?.recipient ?? null}
            isReadOnly={
              selectedChannel !== undefined ? getChannelPerms(selectedChannel).isReadOnly : false
            }
          />
        </Panel>

        {/* WHY: Hide member list in DM mode — DMs have exactly 2 members, no list needed */}
        {!isDmView && (
          <>
            <ResizeHandle />
            <Panel defaultSize="20%" minSize="15%" maxSize="25%" collapsible collapsedSize="0%">
              <MemberList serverId={selectedServerId} serverName={selectedServer?.name ?? null} />
            </Panel>
          </>
        )}
      </Group>
    </div>
  )
}
