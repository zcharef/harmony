import { Chip, Tooltip } from '@heroui/react'
import { GripVertical, WifiOff } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Group, Panel, Separator } from 'react-resizable-panels'

import { FeatureErrorBoundary } from '@/components/shared/error-boundary'
import { ErrorState } from '@/components/shared/error-state'
import { useAuthStore, useCurrentProfile, useRealtimeProfile } from '@/features/auth'
import {
  ChannelSidebar,
  useChannels,
  useRealtimeChannels,
  useRealtimeMentions,
  useRealtimeUnread,
  useUnreadSync,
} from '@/features/channels'
import { ChatArea } from '@/features/chat'
import { DiscoveryPage } from '@/features/discovery'
import { DmSidebar, useDms, useRealtimeDms } from '@/features/dms'
import { FriendsPanel, useRealtimeFriends } from '@/features/friends'
import {
  MemberList,
  useForceDisconnect,
  useMyMemberRole,
  useRealtimeMembers,
} from '@/features/members'
import {
  NotificationPermissionBanner,
  trackFocusLock,
  useDesktopNotifications,
  useNotificationSettingsMap,
  useNotificationSound,
} from '@/features/notifications'
import { OnboardingFlow, useOnboarding } from '@/features/onboarding'
import { usePresence } from '@/features/presence'
import { SearchOverlay } from '@/features/search'
import { useRealtimeEmojis } from '@/features/server-emojis'
import {
  CreateServerDialog,
  ServerList,
  useRealtimeServers,
  useServers,
} from '@/features/server-nav'
import { ServerSettings, UserSettingsModal, useSettingsUiStore } from '@/features/settings'
import { useRealtimeVoicePresence, useVoiceConnection } from '@/features/voice'
import { useFetchSSE } from '@/hooks/use-fetch-sse'
import { useAboutUiStore } from '@/lib/about-ui-store'
import { type ConnectionStatus, useConnectionStatus } from '@/lib/connection-store'
import { useDiscoveryUiStore } from '@/lib/discovery-ui-store'
import { resolveDisplayName } from '@/lib/display-name'
import { env } from '@/lib/env'
import { logger } from '@/lib/logger'
import { NAVIGATE_EVENT, navigateDetailSchema } from '@/lib/navigation-events'
import { readStorage, writeStorage } from '@/lib/storage'
import { supabase } from '@/lib/supabase'
import { AboutPage } from './about-page'
import { ConnectionBanner } from './connection-banner'
import {
  CHAT_DEFAULT_DM,
  CHAT_DEFAULT_SERVER,
  CHAT_MIN,
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX_LEFT,
  SIDEBAR_MAX_MEMBERS,
  SIDEBAR_MIN,
} from './sidebar-sizes'
import { WelcomeScreen } from './welcome-screen'

// WHY: Persist last-used server/channel to localStorage so the user returns
// to their last position on page reload. Follows the same localStorage pattern
// as crypto-store.ts (src/features/crypto/stores/crypto-store.ts:57-63).
const STORAGE_KEYS = {
  lastServerId: 'harmony:lastServerId',
  lastChannelId: (serverId: string) => `harmony:lastChannel:${serverId}`,
} as const

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
      ? resolveDisplayName(activeDm.recipient)
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
  userServers: { id: string }[],
  servers: { id: string }[] | undefined,
  setSelectedServerId: (id: string | null) => void,
  setSelectedChannelId: (id: string | null) => void,
) {
  // WHY: Auto-select a server on initial load. Tries the last-used server
  // from localStorage first (any non-DM server, official included — "return
  // to last position"), then falls back to the first CUSTOM server only.
  // The official server is deliberately excluded from the fallback: an
  // official-only user who never visited it must land on WelcomeScreen /
  // onboarding, not silently inside the official server.
  useEffect(() => {
    if (view !== 'servers' || selectedServerId !== null || regularServers.length === 0) return

    const savedId = readStorage(STORAGE_KEYS.lastServerId)
    const target =
      (savedId !== null ? regularServers.find((s) => s.id === savedId) : undefined) ??
      userServers[0]
    if (target !== undefined) {
      setSelectedServerId(target.id)
    }
  }, [view, selectedServerId, regularServers, userServers, setSelectedServerId])

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
// Mirrors ServerSettingsView: the directory replaces the entire content area.
// It also owns the empty-state "create your own server" dialog so the
// discovery feature does not need to import server-nav's rail internals.
function DiscoveryView({
  connectionStatus,
  onNavigateServer,
}: {
  connectionStatus: ConnectionStatus
  onNavigateServer: (serverId: string) => void
}) {
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const closeDiscovery = useDiscoveryUiStore((s) => s.closeDiscovery)

  const handleNavigate = useCallback(
    (serverId: string) => {
      closeDiscovery()
      onNavigateServer(serverId)
    },
    [closeDiscovery, onNavigateServer],
  )

  return (
    <div
      data-test="main-layout"
      data-test-sse-status={connectionStatus}
      className="flex h-screen w-screen overflow-hidden"
    >
      <ConnectionBanner />
      <DiscoveryPage onJoined={handleNavigate} onCreateServer={() => setIsCreateOpen(true)} />
      <CreateServerDialog
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        onCreated={handleNavigate}
      />
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

// WHY membership check, not just env (ticket §6.9): banned users are skipped
// by auto-join — for them the official server must be treated as absent.
// Extracted to keep MainLayout below Biome's cognitive complexity limit of 15.
function resolveOfficialServerId(regularServers: { id: string }[]): string | null {
  const officialId = env.VITE_OFFICIAL_SERVER_ID
  if (officialId === undefined) return null
  return regularServers.some((s) => s.id === officialId) ? officialId : null
}

// WHY: Extracted to reduce MainLayout cognitive complexity below Biome's limit of 15.
// Mirrors WelcomeView: ServerList rail + ConnectionBanner stay mounted around
// the one-time OnboardingFlow (Discord parity — the rail is always visible).
function OnboardingView({
  onSelectServer,
  onSelectDmView,
  officialServerId,
  onSelectAndComplete,
  onDmStarted,
  onComplete,
  selectedServerId,
  view,
}: {
  onSelectServer: (serverId: string) => void
  onSelectDmView: () => void
  officialServerId: string | null
  onSelectAndComplete: (serverId: string) => void
  onDmStarted: (serverId: string, channelId: string) => void
  onComplete: () => void
  selectedServerId: string | null
  view: ViewMode
}) {
  const sseStatus = useConnectionStatus()
  // WHY here (not in MainLayout): only the onboarding greeting needs the
  // profile — keeps the query out of the always-mounted layout path.
  const { data: profile } = useCurrentProfile()
  const displayName = profile !== undefined ? resolveDisplayName(profile) : ''

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
      <OnboardingFlow
        displayName={displayName}
        officialServerId={officialServerId}
        onExploreOfficial={onSelectAndComplete}
        onServerCreated={onSelectAndComplete}
        onServerJoined={onSelectAndComplete}
        onDmStarted={onDmStarted}
        onComplete={onComplete}
      />
      <AlphaBadge />
    </div>
  )
}

interface MainLayoutProps {
  /**
   * Server to preselect on mount (e.g. just joined via the invite landing).
   * WHY a prop (not localStorage): the invite flow finishes BEFORE MainLayout
   * mounts, and the auto-select effect only fills a null selection — an
   * initial value deterministically wins over the last-used fallback.
   */
  initialServerId?: string | null
}

export function MainLayout({ initialServerId = null }: MainLayoutProps) {
  const [view, setView] = useState<ViewMode>('servers')
  const [selectedServerId, setSelectedServerId] = useState<string | null>(initialServerId)
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null)

  // WHY: Derive server/channel names from query cache to display in headers.
  // This avoids passing full objects between features (CLAUDE.md 4.5: pass IDs, not objects).
  const { data: servers, isError: isServersError } = useServers()
  const connectionStatus = useConnectionStatus()

  // WHY: Filter DM servers so we can check if user has real servers.
  // Same filter applied inside ServerList (server-list.tsx:106).
  const regularServers = useMemo(() => servers?.filter((s) => !s.isDm) ?? [], [servers])

  // WHY: Exclude the official Harmony server from the "has servers" check so
  // new users who were auto-joined still get onboarding / the welcome screen.
  const userServers = useMemo(
    () => regularServers.filter((s) => s.id !== env.VITE_OFFICIAL_SERVER_ID),
    [regularServers],
  )

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
  // WHY: Live server metadata (rename, icon, ownership, discovery settings)
  // patches the rail + settings screens on server.updated. Mounted here so it
  // survives view switches (§4.6).
  useRealtimeServers()
  // WHY: Live custom-emoji resolution — appends/removes from every server's
  // emoji cache on emoji.created/deleted so `:name:` tokens resolve (or degrade
  // to text) without a refetch. Mounted here (not a sidebar) so it survives
  // view switches (§4.6); keyed on the event's serverId, one mount covers all.
  useRealtimeEmojis()
  // WHY: Live identity rehydration — patches every cached member list, DM,
  // message page, and the own-profile cache on profile.updated. Mounted here
  // (not in a sidebar) so it survives DM/server view switches (§4.6).
  useRealtimeProfile(userId)
  // WHY: Mounted here (not in DmSidebar) so dm.created SSE events invalidate
  // the DM list cache even when the DM sidebar is unmounted (user viewing a
  // server). The backend now dynamically updates the server_ids filter via a
  // watch channel, so no client-side reconnect is needed.
  useRealtimeDms()
  // WHY: Mounted here (not in FriendsPanel) so friend/block events + the eager
  // list queries (badges, context-menu state) stay warm across DM/server view
  // switches — FriendsPanel unmounts constantly (§5.2, §4.6).
  useRealtimeFriends()
  // WHY: Mounted here (not in ChatArea) so unread increments happen even when
  // no channel is selected (e.g. DM view with no conversation open). The
  // previous approach coupled incrementing to useRealtimeMessages(channelId)
  // which only subscribed when channelId was non-empty.
  useRealtimeUnread(selectedChannelId)
  // WHY: Mention badge deltas (mention.received + DM mention-equivalence rule).
  // Mounted here beside useRealtimeUnread so mention badges move even when no
  // channel is selected (global-listener rule §4.6).
  useRealtimeMentions(selectedChannelId, userId)
  // WHY: Handles the SSE unread.sync snapshot on connect/reconnect.
  // Replaces N per-server REST calls with a single SSE initial event.
  useUnreadSync(userId)
  // WHY: Fires native notifications (web + Tauri) for incoming messages. Needs
  // selectedChannelId to skip the active channel, userId to filter self-messages.
  useDesktopNotifications(selectedChannelId, userId)
  // WHY: Plays notification sounds (different for DMs vs server channels).
  // Suppression differs from desktop notifications: sound plays when focused
  // on a different channel, desktop notifications suppress on focus alone.
  useNotificationSound(selectedChannelId, userId)
  // WHY: Bulk per-channel notification overrides — fetched once here so the
  // policy respects muted levels for channels never visited this session (D9).
  useNotificationSettingsMap()
  // WHY: Holds the cross-tab Web Lock while this tab is focused, so no tab
  // pops a native notification while the user is looking at ANY same-origin
  // tab (persistent side-effect rule §4.6).
  useEffect(() => trackFocusLock(), [])
  // WHY: Voice lifecycle (heartbeat, token refresh, mute sync, cleanup) MUST
  // survive the DM/server view toggle. ChannelSidebar unmounts in DM view,
  // which killed the heartbeat → server swept sessions after 75s → names
  // disappeared while audio was still working (LiveKit P2P is independent).
  const { joinVoice } = useVoiceConnection()
  // WHY: Global voice-presence reconciliation. On any voice Joined(userId, B)
  // it evicts userId from every OTHER channel's participant cache, killing the
  // ghost-presence-on-switch staleness even for servers/channels whose lists
  // are not mounted. Mounted here (not a sidebar) so it survives view switches
  // (§4.6) — the same reason useVoiceConnection lives here.
  useRealtimeVoicePresence()
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

  // WHY: Onboarding terminal paths — every one writes the completion flag
  // exactly once, then navigates (fire-and-forget optimistic, ticket §6.2).
  // WHY initialServerId !== null: arriving from the invite landing means the
  // user already joined a server — deep-land into it and mark the generic
  // first-run tour complete instead of showing it (invite-landing deep-land).
  const { showOnboarding, completeOnboarding } = useOnboarding(initialServerId !== null)
  const handleOnboardingSelect = useCallback(
    (serverId: string) => {
      completeOnboarding()
      handleSelectServer(serverId)
    },
    [completeOnboarding, handleSelectServer],
  )
  const handleOnboardingDmStarted = useCallback(
    (serverId: string, channelId: string) => {
      completeOnboarding()
      handleNavigateDm(serverId, channelId)
    },
    [completeOnboarding, handleNavigateDm],
  )

  useServerAutoSelect(
    view,
    selectedServerId,
    regularServers,
    userServers,
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
  const showDiscovery = useDiscoveryUiStore((s) => s.showDiscovery)

  const officialServerId = resolveOfficialServerId(regularServers)

  // WHY !showOnboarding: a first-run user with only the auto-joined official
  // server (userServers.length === 0) must get onboarding, not the bare
  // welcome empty state. WelcomeScreen is the steady-state for returning users.
  // WHY selectedServerId === null: an explicit navigation (rail click, the
  // onboarding "Explore" CTA, last-position restore) must win over the empty
  // state — otherwise an official-only user could never view the official
  // server at all (the pre-existing §1.1 invisibility bug).
  const showWelcome =
    servers !== undefined &&
    userServers.length === 0 &&
    !isDmView &&
    !showOnboarding &&
    selectedServerId === null
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

  /** WHY: The server directory replaces the entire main content area (like
   *  server settings). Joining (or "Open" on an existing membership) closes
   *  it and navigates into the server. */
  if (showDiscovery) {
    return (
      <DiscoveryView connectionStatus={connectionStatus} onNavigateServer={handleSelectServer} />
    )
  }

  /** WHY: One-time first-run flow takes precedence over the welcome empty state
   *  (ticket §5.3). Gated on server-persisted onboardingCompleted === false;
   *  never shown while preferences is cold or errored (no flash, no trap).
   *  Skip in DM view — the DmSidebar must stay reachable.
   *  WHY onSelectServer={handleOnboardingSelect}: an explicit rail click must
   *  win over the flow (same rule as the showWelcome guard). It completes
   *  onboarding + navigates, exactly like the explore CTA — otherwise the
   *  click only highlights the rail item while the content stays trapped on
   *  the flow (a user action with no visible effect). Background auto-select
   *  (localStorage restore) does NOT go through this callback, so it cannot
   *  silently complete onboarding. */
  if (showOnboarding && !isDmView) {
    return (
      <OnboardingView
        onSelectServer={handleOnboardingSelect}
        onSelectDmView={handleSelectDmView}
        officialServerId={officialServerId}
        onSelectAndComplete={handleOnboardingSelect}
        onDmStarted={handleOnboardingDmStarted}
        onComplete={completeOnboarding}
        selectedServerId={selectedServerId}
        view={view}
      />
    )
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

      {/* WHY flex-col wrapper: the one-time permission banner sits above the
          resizable content area without disturbing the horizontal panel row. */}
      <div className="flex min-w-0 flex-1 flex-col">
        <NotificationPermissionBanner />

        {/* Resizable panels for sidebar, chat, members */}
        <Group orientation="horizontal" className="flex min-h-0 w-full flex-1">
          <Panel
            data-test="server-sidebar"
            defaultSize={SIDEBAR_DEFAULT}
            minSize={SIDEBAR_MIN}
            maxSize={SIDEBAR_MAX_LEFT}
          >
            <FeatureErrorBoundary name={isDmView ? 'DmSidebar' : 'ChannelSidebar'}>
              {isDmView ? (
                <DmSidebar
                  selectedServerId={selectedServerId}
                  onSelectDm={handleSelectDm}
                  onSelectFriends={handleSelectDmView}
                />
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

          <Panel defaultSize={isDmView ? CHAT_DEFAULT_DM : CHAT_DEFAULT_SERVER} minSize={CHAT_MIN}>
            <FeatureErrorBoundary name="ChatArea">
              {/* WHY: In DM view with no conversation selected, the Friends home
                  replaces ChatArea (Discord parity). Entering DM view resets the
                  selection to null, so this is the DM-view landing screen. */}
              {isDmView && selectedChannelId === null ? (
                <FriendsPanel onNavigateDm={handleNavigateDm} />
              ) : (
                <ChatArea
                  channelId={selectedChannelId}
                  channelName={chatHeaderName}
                  serverId={selectedServerId}
                  currentUserRole={currentUserRole}
                  isDm={chatProps.isDm}
                  dmRecipient={chatProps.dmRecipient}
                  isReadOnly={chatProps.isReadOnly}
                  isChannelEncrypted={chatProps.isChannelEncrypted}
                  slowModeSeconds={chatProps.slowModeSeconds}
                />
              )}
            </FeatureErrorBoundary>
          </Panel>

          {/* WHY: Hide member list in DM mode — DMs have exactly 2 members, no list needed */}
          {isDmView === false && (
            <>
              <ResizeHandle />
              <Panel
                defaultSize={SIDEBAR_DEFAULT}
                minSize={SIDEBAR_MIN}
                maxSize={SIDEBAR_MAX_MEMBERS}
                collapsible
                collapsedSize="0%"
              >
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
      </div>
      {/* WHY here: mounted once so the search overlay survives DM/server view
          switches and both the channel toolbar (in-channel) and the server
          sidebar (server-wide) can open it via the shared store (§5.2). */}
      <SearchOverlay
        serverId={selectedServerId}
        serverName={serverName}
        channels={channels ?? []}
      />
      {/* WHY here: mounted in MainLayout so the modal survives DM/server view
          switches — both sidebars' gear buttons open it (CLAUDE.md 4.6). */}
      <UserSettingsModal />
      <AlphaBadge />
    </div>
  )
}
