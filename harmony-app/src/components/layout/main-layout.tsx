import { Chip, Tooltip } from '@heroui/react'
import { GripVertical } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Group, Panel, Separator } from 'react-resizable-panels'

import { useAuthStore } from '@/features/auth'
import { ChannelSidebar, useChannels } from '@/features/channels'
import { ChatArea } from '@/features/chat'
import { DmSidebar, useDms } from '@/features/dms'
import { MemberList, useMyMemberRole } from '@/features/members'
import { usePresence } from '@/features/presence'
import { ServerList, useServers } from '@/features/server-nav'
import { ServerSettings, useSettingsUiStore } from '@/features/settings'

import { WelcomeScreen } from './welcome-screen'

function AlphaBadge() {
  const { t } = useTranslation('common')
  return (
    <Tooltip content={t('alphaDisclaimer')} placement="top" delay={300}>
      <Chip
        color="warning"
        size="sm"
        variant="flat"
        className="fixed bottom-2 right-2 z-50 cursor-default opacity-70 hover:opacity-100"
      >
        {t('alphaLabel')}
      </Chip>
    </Tooltip>
  )
}

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

// WHY: Extracted to reduce MainLayout cognitive complexity below Biome's limit of 15.
function deriveChatHeader<
  T extends { serverId: string; recipient: { displayName?: string | null; username: string } },
>(
  view: ViewMode,
  dms: T[] | undefined,
  selectedServerId: string | null,
  channelName: string | undefined,
) {
  const activeDm = view === 'dms' ? dms?.find((dm) => dm.serverId === selectedServerId) : undefined
  const name =
    view === 'dms' && activeDm !== undefined
      ? (activeDm.recipient.displayName ?? activeDm.recipient.username)
      : (channelName ?? null)
  return { activeDm, chatHeaderName: name }
}

// WHY: Extracted to reduce MainLayout cognitive complexity below Biome's limit of 15.
function useServerAutoSelect(
  view: ViewMode,
  selectedServerId: string | null,
  regularServers: { id: string }[],
  servers: { id: string }[] | undefined,
  setSelectedServerId: (id: string | null) => void,
  setSelectedChannelId: (id: string | null) => void,
) {
  // WHY: Auto-select the first server on initial load to avoid the
  // "no server selected" dead-end. Only fires when view is 'servers',
  // no server is selected, and servers have finished loading.
  useEffect(() => {
    const firstServer = regularServers[0]
    if (view === 'servers' && selectedServerId === null && firstServer !== undefined) {
      setSelectedServerId(firstServer.id)
    }
  }, [view, selectedServerId, regularServers, setSelectedServerId])

  // WHY: If the selected server was removed (e.g., user was kicked/banned),
  // reset selection so the UI doesn't show stale data.
  useEffect(() => {
    if (selectedServerId !== null && servers !== undefined) {
      const stillExists = servers.some((s) => s.id === selectedServerId)
      if (!stillExists) {
        setSelectedServerId(null)
        setSelectedChannelId(null)
      }
    }
  }, [selectedServerId, servers, setSelectedServerId, setSelectedChannelId])
}

export function MainLayout() {
  const [view, setView] = useState<ViewMode>('servers')
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null)
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null)

  // WHY: Derive server/channel names from query cache to display in headers.
  // This avoids passing full objects between features (CLAUDE.md 4.5: pass IDs, not objects).
  const { data: servers } = useServers()

  // WHY: Filter DM servers so we can check if user has real servers.
  // Same filter applied inside ServerList (server-list.tsx:106).
  const regularServers = useMemo(() => servers?.filter((s) => !s.isDm) ?? [], [servers])

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

  // WHY: Chat header shows DM recipient name or channel name depending on view.
  const { activeDm, chatHeaderName } = deriveChatHeader(
    view,
    dms,
    selectedServerId,
    selectedChannel?.name,
  )

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

  // WHY: Used by MemberContextMenu "Send Message" to switch from server view
  // into DM view and open the newly created conversation in one action.
  const handleNavigateDm = useCallback((serverId: string, channelId: string) => {
    setView('dms')
    setSelectedServerId(serverId)
    setSelectedChannelId(channelId)
  }, [])

  useServerAutoSelect(
    view,
    selectedServerId,
    regularServers,
    servers,
    setSelectedServerId,
    setSelectedChannelId,
  )

  const isDmView = view === 'dms'
  const showServerSettings = useSettingsUiStore((s) => s.showServerSettings)

  const hasNoServers = servers !== undefined && regularServers.length === 0

  /** WHY: Server settings replaces the entire main content area (like Discord). */
  if (showServerSettings && selectedServerId !== null) {
    return (
      <div data-test="main-layout" className="flex h-screen w-screen overflow-hidden">
        <ServerSettings serverId={selectedServerId} />
        <AlphaBadge />
      </div>
    )
  }

  /** WHY: Early return avoids a JSX ternary that would increase nesting complexity
   *  for every conditional inside the Group (Biome cognitive complexity limit). */
  if (hasNoServers) {
    return (
      <div data-test="main-layout" className="flex h-screen w-screen overflow-hidden">
        <ServerList
          selectedServerId={selectedServerId}
          view={view}
          onSelectServer={handleSelectServer}
          onSelectDmView={handleSelectDmView}
        />
        <WelcomeScreen onServerCreated={handleSelectServer} onServerJoined={handleSelectServer} />
        <AlphaBadge />
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
            isReadOnly={selectedChannel !== undefined ? selectedChannel.isReadOnly : false}
          />
        </Panel>

        {/* WHY: Hide member list in DM mode — DMs have exactly 2 members, no list needed */}
        {isDmView === false && (
          <>
            <ResizeHandle />
            <Panel defaultSize="20%" minSize="15%" maxSize="25%" collapsible collapsedSize="0%">
              <MemberList
                serverId={selectedServerId}
                serverName={selectedServer?.name ?? null}
                onNavigateDm={handleNavigateDm}
              />
            </Panel>
          </>
        )}
      </Group>
      <AlphaBadge />
    </div>
  )
}
