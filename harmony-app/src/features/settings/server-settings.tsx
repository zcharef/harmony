import { Button, Spinner } from '@heroui/react'
import {
  Ban,
  Compass,
  Flag,
  Hash,
  Info,
  ScrollText,
  Shield,
  ShieldCheck,
  Smile,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '@/features/auth'
import { ROLE_HIERARCHY, useMyMemberRole } from '@/features/members'
import { AuditLogTab, ReportsTab, useReports } from '@/features/moderation'
import { EmojiSettingsTab } from '@/features/server-emojis'
import { useServers } from '@/features/server-nav'
import { cn } from '@/lib/utils'
import { BansTab } from './bans-tab'
import { ChannelsTab } from './channels-tab'
import { DiscoveryTab } from './discovery-tab'
import { ModerationTab } from './moderation-tab'
import { OverviewTab } from './overview-tab'
import { RolesTab } from './roles-tab'
import { useSettingsUiStore } from './stores/settings-ui-store'

type SettingsTab =
  | 'overview'
  | 'discovery'
  | 'roles'
  | 'channels'
  | 'emojis'
  | 'moderation'
  | 'reports'
  | 'audit'
  | 'bans'

// WHY `adminOnly`: mod-dashboard §9 #1 locks the reports queue to moderator+
// while every other server-settings surface stays admin+. A plain moderator
// therefore reaches the shell but sees only the Reports tab.
const TABS: Array<{ key: SettingsTab; icon: typeof Info; labelKey: string; adminOnly: boolean }> = [
  { key: 'overview', icon: Info, labelKey: 'tabOverview', adminOnly: true },
  { key: 'discovery', icon: Compass, labelKey: 'tabDiscovery', adminOnly: true },
  { key: 'roles', icon: Shield, labelKey: 'tabRoles', adminOnly: true },
  { key: 'channels', icon: Hash, labelKey: 'tabChannels', adminOnly: true },
  { key: 'emojis', icon: Smile, labelKey: 'tabEmojis', adminOnly: true },
  { key: 'moderation', icon: ShieldCheck, labelKey: 'tabModeration', adminOnly: true },
  { key: 'reports', icon: Flag, labelKey: 'tabReports', adminOnly: false },
  { key: 'audit', icon: ScrollText, labelKey: 'tabAudit', adminOnly: true },
  { key: 'bans', icon: Ban, labelKey: 'tabBans', adminOnly: true },
]

interface ServerSettingsProps {
  serverId: string
}

export function ServerSettings({ serverId }: ServerSettingsProps) {
  const { t } = useTranslation('settings')
  const closeServerSettings = useSettingsUiStore((s) => s.closeServerSettings)
  const { role: callerRole } = useMyMemberRole(serverId)
  const { data: servers } = useServers()
  const server = servers?.find((s) => s.id === serverId)
  const currentUserId = useAuthStore((s) => s.user?.id ?? '')
  const isOwner = server?.ownerId === currentUserId
  const [activeTab, setActiveTab] = useState<SettingsTab>('overview')
  // WHY here (not only inside ReportsTab): the badge count must render on the
  // sidebar tab regardless of which tab is open. Moderator+ gate mirrors the API.
  const canModerate = ROLE_HIERARCHY[callerRole] >= ROLE_HIERARCHY.moderator
  const { data: reportsData } = useReports(serverId, canModerate)
  const openReports = reportsData?.openCount ?? 0

  // WHY: The shell is moderator+ because it hosts the moderator+ reports queue
  // (mod-dashboard §9 #1). Admin-only tabs stay gated on isAdmin below.
  const isAdmin = ROLE_HIERARCHY[callerRole] >= ROLE_HIERARCHY.admin
  const visibleTabs = useMemo(
    () => TABS.filter((tab) => isAdmin || tab.adminOnly === false),
    [isAdmin],
  )

  /** WHY: Members (below moderator) have no settings surface — auto-close. */
  useEffect(() => {
    if (canModerate === false) {
      closeServerSettings()
    }
  }, [canModerate, closeServerSettings])

  // WHY: A moderator opening settings would land on the admin-only Overview tab
  // (the default) — redirect to the first tab they can actually see (Reports).
  useEffect(() => {
    if (visibleTabs.some((tab) => tab.key === activeTab) === false) {
      const fallback = visibleTabs[0]?.key
      if (fallback !== undefined) {
        setActiveTab(fallback)
      }
    }
  }, [visibleTabs, activeTab])

  if (server === undefined || canModerate === false) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <Spinner size="lg" />
      </div>
    )
  }

  function handleServerDeleted() {
    closeServerSettings()
  }

  return (
    <div data-test="server-settings" className="flex h-screen w-full bg-background">
      {/* Left sidebar with tab navigation */}
      <div className="flex w-56 flex-col border-r border-divider bg-default-100">
        <div className="flex h-12 items-center border-b border-divider px-4">
          <span className="truncate text-sm font-semibold text-foreground">{server.name}</span>
        </div>
        <nav className="flex-1 overflow-y-auto p-2" aria-label={t('settingsTabs')}>
          {visibleTabs.map(({ key, icon: Icon, labelKey }) => (
            <button
              key={key}
              type="button"
              onClick={() => setActiveTab(key)}
              className={cn(
                'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                activeTab === key
                  ? 'bg-default-200 text-foreground'
                  : 'text-default-500 hover:bg-default-200 hover:text-foreground',
              )}
              data-test={`settings-tab-${key}`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="flex-1 text-left">{t(labelKey)}</span>
              {key === 'reports' && openReports > 0 && (
                <span
                  className="rounded-full bg-danger px-1.5 text-xs font-semibold text-danger-foreground tabular-nums"
                  data-test="reports-tab-badge"
                >
                  {openReports}
                </span>
              )}
            </button>
          ))}
        </nav>
      </div>

      {/* Content area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex h-12 items-center justify-between border-b border-divider px-6">
          <h1 className="text-sm font-semibold text-foreground">
            {t(TABS.find((tab) => tab.key === activeTab)?.labelKey ?? 'tabOverview')}
          </h1>
          <Button
            variant="light"
            isIconOnly
            size="sm"
            onPress={closeServerSettings}
            aria-label={t('closeSettings')}
            data-test="close-settings-button"
          >
            <X className="h-5 w-5 text-default-500" />
          </Button>
        </div>
        {/* WHY one shared column: every tab renders inside a single centered
            max-w-3xl (~768px, in Discord's ~740px settings-pane range) with
            uniform px-8 py-6, so switching tabs never shifts the content width
            or left edge. Tabs must NOT re-declare their own width cap. */}
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl px-8 py-6">
            {/* WHY isAdmin guards: these tabs are admin+ (mod-dashboard §9 #1).
                The nav already hides them from moderators; the guard is
                defense-in-depth so an admin-only surface never renders for a
                moderator, even for a single render before the tab redirect. */}
            {isAdmin && activeTab === 'overview' && (
              <OverviewTab
                server={server}
                callerRole={callerRole}
                onServerDeleted={handleServerDeleted}
              />
            )}
            {isAdmin && activeTab === 'discovery' && <DiscoveryTab server={server} />}
            {isAdmin && activeTab === 'roles' && (
              <RolesTab serverId={serverId} callerRole={callerRole} />
            )}
            {isAdmin && activeTab === 'channels' && (
              <ChannelsTab serverId={serverId} callerRole={callerRole} isOwner={isOwner} />
            )}
            {isAdmin && activeTab === 'emojis' && <EmojiSettingsTab serverId={serverId} />}
            {isAdmin && activeTab === 'moderation' && (
              <ModerationTab serverId={serverId} isOwner={isOwner} />
            )}
            {activeTab === 'reports' && <ReportsTab serverId={serverId} callerRole={callerRole} />}
            {isAdmin && activeTab === 'audit' && (
              <AuditLogTab serverId={serverId} callerRole={callerRole} />
            )}
            {isAdmin && activeTab === 'bans' && (
              <BansTab serverId={serverId} callerRole={callerRole} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
