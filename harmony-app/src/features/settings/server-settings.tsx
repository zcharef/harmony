import { Button, Spinner } from '@heroui/react'
import { Ban, Flag, Hash, Info, ScrollText, Shield, ShieldCheck, Smile, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '@/features/auth'
import { ROLE_HIERARCHY, useMyMemberRole } from '@/features/members'
import { AuditLogTab, ReportsTab, useReports } from '@/features/moderation'
import { EmojiSettingsTab } from '@/features/server-emojis'
import { useServers } from '@/features/server-nav'
import { cn } from '@/lib/utils'
import { BansTab } from './bans-tab'
import { ChannelsTab } from './channels-tab'
import { ModerationTab } from './moderation-tab'
import { OverviewTab } from './overview-tab'
import { RolesTab } from './roles-tab'
import { useSettingsUiStore } from './stores/settings-ui-store'

type SettingsTab =
  | 'overview'
  | 'roles'
  | 'channels'
  | 'emojis'
  | 'moderation'
  | 'reports'
  | 'audit'
  | 'bans'

const TABS: Array<{ key: SettingsTab; icon: typeof Info; labelKey: string }> = [
  { key: 'overview', icon: Info, labelKey: 'tabOverview' },
  { key: 'roles', icon: Shield, labelKey: 'tabRoles' },
  { key: 'channels', icon: Hash, labelKey: 'tabChannels' },
  { key: 'emojis', icon: Smile, labelKey: 'tabEmojis' },
  { key: 'moderation', icon: ShieldCheck, labelKey: 'tabModeration' },
  { key: 'reports', icon: Flag, labelKey: 'tabReports' },
  { key: 'audit', icon: ScrollText, labelKey: 'tabAudit' },
  { key: 'bans', icon: Ban, labelKey: 'tabBans' },
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

  /** WHY: Non-admin users must not access server settings. Auto-close if they lack permission. */
  const isAdmin = ROLE_HIERARCHY[callerRole] >= ROLE_HIERARCHY.admin
  useEffect(() => {
    if (isAdmin === false) {
      closeServerSettings()
    }
  }, [isAdmin, closeServerSettings])

  if (server === undefined || isAdmin === false) {
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
    <div data-test="server-settings" className="flex h-screen bg-background">
      {/* Left sidebar with tab navigation */}
      <div className="flex w-56 flex-col border-r border-divider bg-default-100">
        <div className="flex h-12 items-center border-b border-divider px-4">
          <span className="truncate text-sm font-semibold text-foreground">{server.name}</span>
        </div>
        <nav className="flex-1 overflow-y-auto p-2" aria-label={t('settingsTabs')}>
          {TABS.map(({ key, icon: Icon, labelKey }) => (
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
        <div className="flex-1 overflow-y-auto p-6">
          {activeTab === 'overview' && (
            <OverviewTab
              server={server}
              callerRole={callerRole}
              onServerDeleted={handleServerDeleted}
            />
          )}
          {activeTab === 'roles' && <RolesTab serverId={serverId} callerRole={callerRole} />}
          {activeTab === 'channels' && (
            <ChannelsTab serverId={serverId} callerRole={callerRole} isOwner={isOwner} />
          )}
          {activeTab === 'emojis' && <EmojiSettingsTab serverId={serverId} />}
          {activeTab === 'moderation' && <ModerationTab serverId={serverId} isOwner={isOwner} />}
          {activeTab === 'reports' && <ReportsTab serverId={serverId} callerRole={callerRole} />}
          {activeTab === 'audit' && <AuditLogTab serverId={serverId} callerRole={callerRole} />}
          {activeTab === 'bans' && <BansTab serverId={serverId} callerRole={callerRole} />}
        </div>
      </div>
    </div>
  )
}
