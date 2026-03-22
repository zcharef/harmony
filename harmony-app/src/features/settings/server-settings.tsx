import { Button, Spinner } from '@heroui/react'
import { Ban, Hash, Info, Shield, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ROLE_HIERARCHY, useMyMemberRole } from '@/features/members'
import { useServers } from '@/features/server-nav'
import { cn } from '@/lib/utils'
import { BansTab } from './bans-tab'
import { ChannelsTab } from './channels-tab'
import { OverviewTab } from './overview-tab'
import { RolesTab } from './roles-tab'
import { useSettingsUiStore } from './stores/settings-ui-store'

type SettingsTab = 'overview' | 'roles' | 'channels' | 'bans'

const TABS: Array<{ key: SettingsTab; icon: typeof Info; labelKey: string }> = [
  { key: 'overview', icon: Info, labelKey: 'tabOverview' },
  { key: 'roles', icon: Shield, labelKey: 'tabRoles' },
  { key: 'channels', icon: Hash, labelKey: 'tabChannels' },
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
  const [activeTab, setActiveTab] = useState<SettingsTab>('overview')

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
      <div className="flex w-56 flex-col border-r border-divider bg-default-50">
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
                  : 'text-default-500 hover:bg-default-100 hover:text-foreground',
              )}
              data-test={`settings-tab-${key}`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span>{t(labelKey)}</span>
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
          {activeTab === 'channels' && <ChannelsTab serverId={serverId} callerRole={callerRole} />}
          {activeTab === 'bans' && <BansTab serverId={serverId} callerRole={callerRole} />}
        </div>
      </div>
    </div>
  )
}
