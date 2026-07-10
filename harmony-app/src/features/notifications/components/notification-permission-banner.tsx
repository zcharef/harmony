import { Button } from '@heroui/react'
import { Bell } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { usePreferences } from '@/features/preferences'
import { isTauri } from '@/lib/platform'
import { readStorage, writeStorage } from '@/lib/storage'
import { useNotificationPermission } from '../hooks/use-notification-permission'
import { NOTIF_PROMPT_DISMISSED_KEY } from '../lib/notification-storage'

/**
 * One-time inline banner inviting the user to enable web notifications.
 *
 * NEVER-NAG: shown at most once per device, ever — BOTH buttons dismiss
 * forever (localStorage flag), including after "Enable → denied" (the
 * settings tab then carries the blocked state). Web only: permission is
 * `default` and notifications aren't disabled in preferences.
 */
export function NotificationPermissionBanner() {
  const { t } = useTranslation('settings')
  const preferences = usePreferences()
  const { state: permission, request } = useNotificationPermission()
  const [dismissed, setDismissed] = useState(() => readStorage(NOTIF_PROMPT_DISMISSED_KEY) !== null)

  function dismissForever() {
    writeStorage(NOTIF_PROMPT_DISMISSED_KEY, '1')
    setDismissed(true)
  }

  function handleEnable() {
    dismissForever()
    void request()
  }

  // WHY notificationsEnabled !== false: loading (undefined) counts as the
  // server default (true) — the "loading ≠ suppress" rule.
  const visible =
    !isTauri() &&
    permission === 'default' &&
    !dismissed &&
    preferences.data?.notificationsEnabled !== false

  if (!visible) return null

  return (
    <section
      aria-label={t('notifBannerText')}
      className="flex items-center justify-between gap-3 border-b border-divider bg-content2 px-4 py-2"
      data-test="notification-permission-banner"
    >
      <div className="flex items-center gap-2 text-sm text-foreground">
        <Bell className="h-4 w-4 text-default-500" />
        <span>{t('notifBannerText')}</span>
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          color="primary"
          variant="flat"
          onPress={handleEnable}
          data-test="notification-banner-enable"
        >
          {t('notifBannerEnable')}
        </Button>
        <Button
          size="sm"
          variant="light"
          onPress={dismissForever}
          data-test="notification-banner-dismiss"
        >
          {t('notifBannerDismiss')}
        </Button>
      </div>
    </section>
  )
}
