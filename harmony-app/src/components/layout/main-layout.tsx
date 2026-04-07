import { Chip, Tooltip } from '@heroui/react'
import { GripVertical, WifiOff } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Group, Panel, Separator } from 'react-resizable-panels'

import { FeatureErrorBoundary } from '@/components/shared/error-boundary'
import { ErrorState } from '@/components/shared/error-state'
import { useAuthStore } from '@/features/auth'
import {
  ChannelSidebar,
  useChannels,
  useDesktopNotifications,
  useRealtimeChannels,
  useRealtimeUnread,
  useUnreadSync,
} from '@/features/channels'
import { ChatArea } from '@/features/chat'
import { DmSidebar, useDms, useRealtimeDms } from '@/features/dms'
import {
  MemberList,
  useForceDisconnect,
  useMyMemberRole,
  useRealtimeMembers,
} from '@/features/members'
import { usePresence } from '@/features/presence'
import { ServerList, useServers } from '@/features/server-nav'
import { ServerSettings, useSettingsUiStore } from '@/features/settings'
import { useVoiceConnection } from '@/features/voice'
import { useFetchSSE } from '@/hooks/use-fetch-sse'
import { useNotificationSound } from '@/hooks/use-notification-sound'
import { useAboutUiStore } from '@/lib/about-ui-store'
import { type ConnectionStatus, useConnectionStatus } from '@/lib/connection-store'
import { env } from '@/lib/env'
import { logger } from '@/lib/logger'
import { NAVIGATE_EVENT, navigateDetailSchema } from '@/lib/navigation-events'
import { supabase } from '@/lib/supabase'
import { AboutPage } from './about-page'
import { ConnectionBanner } from './connection-banner'
import { WelcomeScreen } from './welcome-screen'

// WHY: Persist last-used server/channel to localStorage so the user returns
// to their last position on page reload. Follows the same localStorage pattern
// as crypto-store.ts (src/features/crypto/stores/crypto-store.ts:57-63).
const STORAGE_KEYS = {
  lastServerId: 'harmony:lastServerId',
  lastChannelId: (serverId: string) => `harmony:lastChannel:${serverId}`,
} as const

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch (err: unknown) {
    logger.warn('write_storage_failed', {
      key,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

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
function deriveChatProps<R>(
  isDmView: boolean,
  selectedChannelId: string | null,
  dmRecipientRaw: R | undefined,
  selectedChannel: { isReadOnly: boolean; encrypted: boolean; slowModeSeconds: number } | undefined,
) {
  const isDm = isDmView && selectedChannelId !== null
  const dmRecipient: R | null = dmRecipientRaw ?? null
  const isReadOnly = selectedChannel !== undefined ? selectedChannel.isReadOnly : false
  const isChannelEncrypted = selectedChannel !== undefined ? selectedChannel.encrypted : false
  const slowModeSeconds = selectedChannel !== undefined ? selectedChannel.slowModeSeconds : 0
  return { isDm, dmRecipient, isReadOnly, isChannelEncrypted, slowModeSeconds }
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
  // WHY: Auto-select a server on initial load. Tries the last-used server
  // from localStorage first, falls back to first server if not found/deleted.
  useEffect(() => {
    if (view !== 'servers' || selectedServerId !== null || regularServers.length === 0) return

    const savedId = readStorage(STORAGE_KEYS.lastServerId)
    const target =
      (savedId !== null ? regularServers.find((s) => s.id === savedId) : undefined) ??
      regularServers[0]
    if (target !== undefined) {
      setSelectedServerId(target.id)
    }
  }, [view, selectedServerId, regularServers, setSelectedServerId])

  // WHY: If the selected server was removed (e.g., user was kicked/banned),
  // reset selection so the UI doesn't show stale data.
  // IMPORTANT: Only applies in 'servers' view. In 'dms' view, selectedServerId
  // points to a DM server which may not yet appear in the useServers() cache
  // (createDm invalidates the query, but refetch is async). Resetting here
  // would race against the cache refresh and clear the DM selection.
  useEffect(() => {
    if (view === 'servers' && selectedServerId !== null && servers !== undefined) {
      const stillExists = servers.some((s) => s.id === selectedServerId)
      if (!stillExists) {
        setSelectedServerId(null)
        setSelectedChannelId(null)
      }
    }
  }, [view, selectedServerId, servers, setSelectedServerId, setSelectedChannelId])
}

// WHY: Auto-select a channel when a server is selected and channels have loaded.
// Tries the last-used channel for this server from localStorage, falls back to first.
function useChannelAutoSelect(
  view: ViewMode,
  selectedServerId: string | null,
  selectedChannelId: string | null,
  channels: { id: string }[] | undefined,
  setSelectedChannelId: (id: string | null) => void,
) {
  useEffect(() => {
    if (view !== 'servers' || selectedServerId === null) return
    if (channels === undefined || channels.length === 0) return
    // WHY: If the current selection is still valid, don't override user choice
    if (selectedChannelId !== null && channels.some((c) => c.id === selectedChannelId)) return

    const savedId = readStorage(STORAGE_KEYS.lastChannelId(selectedServerId))
    const target =
      (savedId !== null ? channels.find((c) => c.id === savedId) : undefined) ?? channels[0]
    if (target !== undefined) {
      setSelectedChannelId(target.id)
    }
  }, [view, selectedServerId, selectedChannelId, channels, setSelectedChannelId])
}

// WHY: Persist selection to localStorage so the user returns to their last
// position on page reload. Only persists in server view to avoid overwriting
// with DM server/channel IDs.
function useSelectionPersistence(
  view: ViewMode,
  selectedServerId: string | null,
  selectedChannelId: string | null,
) {
  useEffect(() => {
    if (view === 'servers' && selectedServerId !== null) {
      writeStorage(STORAGE_KEYS.lastServerId, selectedServerId)
    }
  }, [view, selectedServerId])

  useEffect(() => {
    if (view === 'servers' && selectedServerId !== null && selectedChannelId !== null) {
      writeStorage(STORAGE_KEYS.lastChannelId(selectedServerId), selectedChannelId)
    }
  }, [view, selectedServerId, selectedChannelId])
}

// WHY: Handles navigation triggered by clicking a desktop notification.
// The notification hook dispatches a CustomEvent(NAVIGATE_EVENT) on `window`
// with { serverId, channelId } detail. Uses direct addEventListener instead
// of useServerEvent because useServerEvent hardcodes an `sse:` prefix
// (use-server-event.ts:17) making it unsuitable for non-SSE custom events.
function useNotificationNavigation(
  servers: { id: string; isDm: boolean }[] | undefined,
  setView: (view: ViewMode) => void,
  setSelectedServerId: (id: string | null) => void,
  setSelectedChannelId: (id: string | null) => void,
) {
  useEffect(() => {
    function handleNavigate(e: Event) {
      if (!(e instanceof CustomEvent)) return
      const parsed = navigateDetailSchema.safeParse(e.detail)
      if (!parsed.success) return

      const { serverId, channelId } = parsed.data
      const isDm = servers?.find((s) => s.id === serverId)?.isDm === true

      setView(isDm ? 'dms' : 'servers')
      setSelectedServerId(serverId)
      setSelectedChannelId(channelId)
    }

    window.addEventListener(NAVIGATE_EVENT, handleNavigate)
    return () => {
      window.removeEventListener(NAVIGATE_EVENT, handleNavigate)
    }
  }, [servers, setView, setSelectedServerId, setSelectedChannelId])
}

// WHY: Extracted to reduce MainLayout cognitive complexity below Biome's limit of 15.
function ServersErrorView({
  onSelectServer,
  onSelectDmView,
  selectedServerId,
  view,
}: {
  onSelectServer: (serverId: string) => void
  onSelectDmView: () => void
  selectedServerId: string | null
  view: ViewMode
}) {
  const { t } = useTranslation('common')
  const sseStatus = useConnectionStatus()
  return (
    <div
      data-test="main-layout"
      data-test-sse-status={sseStatus}
      className="flex h-screen w-screen overflow-hidden"
    >
      <ConnectionBanner />
      <ServerList
        selectedServerId={selectedServerId}
        view={view}
        onSelectServer={onSelectServer}
        onSelectDmView={onSelectDmView}
      />
      <div className="flex flex-1 items-center justify-center bg-background">
        <ErrorState icon={<WifiOff className="h-12 w-12" />} message={t('somethingWentWrong')} />
      </div>
      <AlphaBadge />
    </div>
  )
}

// WHY: Extracted to reduce MainLayout cognitive complexity below Biome's limit of 15.
function ServerSettingsView({
  serverId,
  connectionStatus,
}: {
  serverId: string
  connectionStatus: ConnectionStatus
}) {
  return (
    <div
      data-test="main-layout"
      data-test-sse-status={connectionStatus}
      className="flex h-screen w-screen overflow-hidden"
    >
      <ConnectionBanner />
      <ServerSettings serverId={serverId} />
      <AlphaBadge />
    </div>
  )
}

// WHY: Extracted to reduce MainLayout cognitive complexity below Biome's limit of 15.
function AboutPageView({ connectionStatus }: { connectionStatus: ConnectionStatus }) {
  return (
    <div
      data-test="main-layout"
      data-test-sse-status={connectionStatus}
      className="flex h-screen w-screen overflow-hidden"
    >
      <AboutPage />
    </div>
  )
}

// WHY: Extracted to reduce MainLayout cognitive complexity below Biome's limit of 15.
function WelcomeView({
  onSelectServer,
  onSelectDmView,
  onServerCreated,
  onServerJoined,
  selectedServerId,
  view,
}: {
  onSelectServer: (serverId: string) => void
  onSelectDmView: () => void
  onServerCreated: (serverId: string) => void
  onServerJoined: (serverId: string) => void
  selectedServerId: string | null
  view: ViewMode
}) {
  const sseStatus = useConnectionStatus()
  return (
    <div
      data-test="main-layout"
      data-test-sse-status={sseStatus}
      className="flex h-screen w-screen overflow-hidden"
    >
      <ConnectionBanner />
      <ServerList
        selectedServerId={selectedServerId}
        view={view}
        onSelectServer={onSelectServer}
        onSelectDmView={onSelectDmView}
      />
      <WelcomeScreen onServerCreated={onServerCreated} onServerJoined={onServerJoined} />
      <AlphaBadge />
    </div>
  )
}

export function MainLayout() {
  const [view, setView] = useState<ViewMode>('servers')
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null)
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null)

  // WHY: Derive server/channel names from query cache to display in headers.
  // This avoids passing full objects between features (CLAUDE.md 4.5: pass IDs, not objects).
  const { data: servers, isError: isServersError } = useServers()
  const connectionStatus = useConnectionStatus()

  // WHY: Filter DM servers so we can check if user has real servers.
  // Same filter applied inside ServerList (server-list.tsx:106).
  const regularServers = useMemo(() => servers?.filter((s) => !s.isDm) ?? [], [servers])

  // WHY: Presence subscribes to ALL servers so the user appears online to
  // friends everywhere, not just on the currently viewed server.
  const userId = useAuthStore((s) => s.user?.id ?? null)
  // WHY: Stable callback that returns the latest Supabase JWT.
  // getSession() auto-refreshes expired access tokens internally.
  // Token rotation is handled by AuthProvider reacting to TOKEN_REFRESHED.
  // If the session isn't cached yet (race: userId set before Supabase SDK
  // initializes), waits for onAuthStateChange callback instead of returning
  // undefined — the SSE loop should never start without a valid token.
  const getToken = useCallback(async () => {
    const {
      data: { session },
    } = await supabase.auth.getSession()
    if (session?.access_token !== undefined) return session.access_token

    // WHY: userId is non-null (SSE hook is gated) but Supabase session isn't
    // cached yet. Subscribe to auth state changes and resolve when the token
    // appears. 5s safety timeout prevents hanging if auth is truly dead.
    return new Promise<string | undefined>((resolve) => {
      let sub: { unsubscribe: () => void } | undefined

      const timeout = setTimeout(() => {
        sub?.unsubscribe()
        logger.warn('sse_token_timeout', { reason: 'onAuthStateChange did not fire within 5s' })
        resolve(undefined)
      }, 5_000)

      const {
        data: { subscription },
      } = supabase.auth.onAuthStateChange((_event, sess) => {
        if (sess?.access_token !== undefined) {
          clearTimeout(timeout)
          subscription.unsubscribe()
          resolve(sess.access_token)
        }
      })
      sub = subscription
    })
  }, [])
  usePresence(userId)
  useFetchSSE(userId, getToken)
  useForceDisconnect(userId, selectedServerId, setSelectedServerId, setSelectedChannelId)
  // WHY: Realtime hooks MUST live here (not inside collapsible sidebar/member-list
  // panels). When a panel collapses, its component unmounts and SSE listeners are
  // torn down — events would be silently missed until the panel re-opens.
  useRealtimeChannels()
  useRealtimeMembers()
  // WHY: Mounted here (not in DmSidebar) so dm.created SSE events invalidate
  // the DM list cache even when the DM sidebar is unmounted (user viewing a
  // server). The backend now dynamically updates the server_ids filter via a
  // watch channel, so no client-side reconnect is needed.
  useRealtimeDms()
  // WHY: Mounted here (not in ChatArea) so unread increments happen even when
  // no channel is selected (e.g. DM view with no conversation open). The
  // previous approach coupled incrementing to useRealtimeMessages(channelId)
  // which only subscribed when channelId was non-empty.
  useRealtimeUnread(selectedChannelId)
  // WHY: Handles the SSE unread.sync snapshot on connect/reconnect.
  // Replaces N per-server REST calls with a single SSE initial event.
  useUnreadSync(userId)
  // WHY: Fires native desktop notifications for incoming messages. Needs
  // selectedChannelId to skip the active channel, userId to filter self-messages.
  useDesktopNotifications(selectedChannelId, userId)
  // WHY: Plays notification sounds (different for DMs vs server channels).
  // Suppression differs from desktop notifications: sound plays when focused
  // on a different channel, desktop notifications suppress on focus alone.
  useNotificationSound(selectedChannelId, userId)
  // WHY: Voice lifecycle (heartbeat, token refresh, mute sync, cleanup) MUST
  // survive the DM/server view toggle. ChannelSidebar unmounts in DM view,
  // which killed the heartbeat → server swept sessions after 75s → names
  // disappeared while audio was still working (LiveKit P2P is independent).
  const { joinVoice } = useVoiceConnection()
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

  useChannelAutoSelect(view, selectedServerId, selectedChannelId, channels, setSelectedChannelId)
  useSelectionPersistence(view, selectedServerId, selectedChannelId)
  useNotificationNavigation(servers, setView, setSelectedServerId, setSelectedChannelId)

  const isDmView = view === 'dms'
  const showAboutPage = useAboutUiStore((s) => s.showAboutPage)
  const showServerSettings = useSettingsUiStore((s) => s.showServerSettings)

  // WHY: Exclude the official Harmony server from the "has servers" check so
  // new users who were auto-joined still see the onboarding welcome screen.
  const userServers = useMemo(
    () => regularServers.filter((s) => s.id !== env.VITE_OFFICIAL_SERVER_ID),
    [regularServers],
  )
  const showWelcome = servers !== undefined && userServers.length === 0 && !isDmView
  const showServersError = isServersError && servers === undefined && !isDmView

  // WHY: Pre-compute props to move ternary/logical complexity out of MainLayout,
  // reducing Biome cognitive complexity below the limit of 15.
  const chatProps = deriveChatProps(
    isDmView,
    selectedChannelId,
    activeDm?.recipient,
    selectedChannel,
  )
  const serverName = selectedServer?.name ?? null

  /** WHY: About page renders before server settings so it's accessible from any state. */
  if (showAboutPage) {
    return <AboutPageView connectionStatus={connectionStatus} />
  }

  /** WHY: Server settings replaces the entire main content area (like Discord). */
  if (showServerSettings && selectedServerId !== null) {
    return <ServerSettingsView serverId={selectedServerId} connectionStatus={connectionStatus} />
  }

  /** WHY: Early return avoids a JSX ternary that would increase nesting complexity
   *  for every conditional inside the Group (Biome cognitive complexity limit).
   *  Skip when in DM view — a kicked user with no servers must still see DmSidebar. */
  if (showWelcome) {
    return (
      <WelcomeView
        onSelectServer={handleSelectServer}
        onSelectDmView={handleSelectDmView}
        onServerCreated={handleSelectServer}
        onServerJoined={handleSelectServer}
        selectedServerId={selectedServerId}
        view={view}
      />
    )
  }

  /** WHY: Servers query failed with no cache — show error instead of blank app.
   *  The ConnectionBanner handles SSE-level errors; this covers REST query failures. */
  if (showServersError) {
    return (
      <ServersErrorView
        selectedServerId={selectedServerId}
        view={view}
        onSelectServer={handleSelectServer}
        onSelectDmView={handleSelectDmView}
      />
    )
  }

  return (
    <div
      data-test="main-layout"
      data-test-sse-status={connectionStatus}
      className="flex h-screen w-screen overflow-hidden"
    >
      <ConnectionBanner />
      {/* Server nav - fixed width, outside resizable group */}
      <ServerList
        selectedServerId={selectedServerId}
        view={view}
        onSelectServer={handleSelectServer}
        onSelectDmView={handleSelectDmView}
      />

      {/* Resizable panels for sidebar, chat, members */}
      <Group orientation="horizontal" className="flex h-full w-full flex-1">
        <Panel data-test="server-sidebar" defaultSize="20%" minSize="15%" maxSize="30%">
          <FeatureErrorBoundary name={isDmView ? 'DmSidebar' : 'ChannelSidebar'}>
            {isDmView ? (
              <DmSidebar selectedServerId={selectedServerId} onSelectDm={handleSelectDm} />
            ) : (
              <ChannelSidebar
                serverId={selectedServerId}
                serverName={serverName}
                selectedChannelId={selectedChannelId}
                onSelectChannel={setSelectedChannelId}
                joinVoice={joinVoice}
              />
            )}
          </FeatureErrorBoundary>
        </Panel>

        <ResizeHandle />

        <Panel defaultSize={isDmView ? '80%' : '60%'} minSize="30%">
          <FeatureErrorBoundary name="ChatArea">
            <ChatArea
              channelId={selectedChannelId}
              channelName={chatHeaderName}
              currentUserRole={currentUserRole}
              isDm={chatProps.isDm}
              dmRecipient={chatProps.dmRecipient}
              isReadOnly={chatProps.isReadOnly}
              isChannelEncrypted={chatProps.isChannelEncrypted}
              slowModeSeconds={chatProps.slowModeSeconds}
            />
          </FeatureErrorBoundary>
        </Panel>

        {/* WHY: Hide member list in DM mode — DMs have exactly 2 members, no list needed */}
        {isDmView === false && (
          <>
            <ResizeHandle />
            <Panel defaultSize="20%" minSize="15%" maxSize="25%" collapsible collapsedSize="0%">
              <FeatureErrorBoundary name="MemberList">
                <MemberList
                  serverId={selectedServerId}
                  serverName={serverName}
                  onNavigateDm={handleNavigateDm}
                />
              </FeatureErrorBoundary>
            </Panel>
          </>
        )}
      </Group>
      <AlphaBadge />
    </div>
  )
}
