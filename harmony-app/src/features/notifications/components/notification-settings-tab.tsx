import { Button, Chip, Divider, Skeleton, Switch } from '@heroui/react'
import { useTranslation } from 'react-i18next'
import { usePreferences, useUpdatePreferences } from '@/features/preferences'
import type { UpdateUserPreferencesRequest } from '@/lib/api'
import { isTauri } from '@/lib/platform'
import { useNotificationPermission } from '../hooks/use-notification-permission'
import { MENTIONS_FEATURE_LIVE } from '../lib/notification-policy'

/**
 * Notifications tab of the User Settings modal.
 *
 * All switches read straight from the preferences query cache (ADR-045 — no
 * useState shadow) and mutate via the shared optimistic hook, so a toggle is
 * honored by the very next incoming event with zero refetch.
 */
export function NotificationSettingsTab() {
  const { t } = useTranslation('settings')
  const preferences = usePreferences()
  const updatePreferences = useUpdatePreferences()
  const { state: permission, request } = useNotificationPermission()

  if (preferences.isPending) {
    return (
      <div className="flex flex-col gap-4 py-2" data-test="notification-settings-loading">
        <Skeleton className="h-8 rounded-lg" />
        <Skeleton className="h-8 rounded-lg" />
        <Skeleton className="h-8 rounded-lg" />
        <Skeleton className="h-8 rounded-lg" />
      </div>
    )
  }

  if (preferences.isError) {
    return (
      <div className="flex flex-col items-start gap-2 py-2" data-test="notification-settings-error">
        <p className="text-sm text-danger">{t('notifLoadError')}</p>
        <Button size="sm" variant="flat" onPress={() => void preferences.refetch()}>
          {t('notifRetry')}
        </Button>
      </div>
    )
  }

  const prefs = preferences.data

  function toggle(patch: UpdateUserPreferencesRequest) {
    updatePreferences.mutate(patch)
  }

  function handleMasterToggle(enabled: boolean) {
    toggle({ notificationsEnabled: enabled })
    // WHY here: a Switch press is a user gesture — the only mount-free moment
    // web permission may be requested (never on load, never on events).
    if (enabled && !isTauri() && permission === 'default') {
      void request()
    }
  }

  return (
    <div className="flex flex-col gap-4 py-2" data-test="notification-settings-tab">
      {prefs?.dndEnabled === true && (
        <p
          role="status"
          className="rounded-lg bg-default-100 px-3 py-2 text-sm text-default-600"
          data-test="notification-dnd-hint"
        >
          {t('notifDndActive')}
        </p>
      )}

      <div className="flex items-center justify-between gap-2">
        <Switch
          isSelected={prefs?.notificationsEnabled === true}
          onValueChange={handleMasterToggle}
          isDisabled={permission === 'unsupported'}
          data-test="notification-master-switch"
        >
          <div className="flex flex-col">
            <span>{t('notifDesktopLabel')}</span>
            <span className="text-xs text-default-500">{t('notifDesktopHelp')}</span>
          </div>
        </Switch>
        <PermissionStatus permission={permission} onEnable={() => void request()} />
      </div>
      {permission === 'denied' && (
        <p className="text-xs text-warning" data-test="notification-permission-denied-help">
          {t('notifPermissionDenied')}
        </p>
      )}
      {permission === 'unsupported' && (
        <p className="text-xs text-default-500" data-test="notification-permission-unsupported">
          {t('notifPermissionUnsupported')}
        </p>
      )}

      <Switch
        isSelected={prefs?.notifyMessages === true}
        onValueChange={(v) => toggle({ notifyMessages: v })}
        data-test="notification-messages-switch"
      >
        {t('notifServerMessages')}
      </Switch>

      <Switch
        isSelected={prefs?.notifyDms === true}
        onValueChange={(v) => toggle({ notifyDms: v })}
        data-test="notification-dms-switch"
      >
        {t('notifDirectMessages')}
      </Switch>

      {MENTIONS_FEATURE_LIVE && (
        <Switch
          isSelected={prefs?.notifyMentions === true}
          onValueChange={(v) => toggle({ notifyMentions: v })}
          data-test="notification-mentions-switch"
        >
          {t('notifMentions')}
        </Switch>
      )}

      <Divider />

      <Switch
        isSelected={prefs?.notificationSoundsEnabled === true}
        onValueChange={(v) => toggle({ notificationSoundsEnabled: v })}
        data-test="notification-sounds-switch"
      >
        {t('notifSoundsLabel')}
      </Switch>
    </div>
  )
}

/**
 * WHY web-only chip: Tauri permission is OS-level and pre-granted in
 * practice — the enable/blocked affordances only make sense in a browser.
 */
function PermissionStatus({
  permission,
  onEnable,
}: {
  permission: 'granted' | 'denied' | 'default' | 'unsupported'
  onEnable: () => void
}) {
  const { t } = useTranslation('settings')

  if (isTauri()) return null

  if (permission === 'default') {
    return (
      <div className="flex items-center gap-2" role="status">
        <Button
          size="sm"
          color="primary"
          variant="flat"
          onPress={onEnable}
          data-test="notification-permission-enable"
        >
          {t('notifPermissionEnable')}
        </Button>
      </div>
    )
  }

  if (permission === 'denied') {
    return (
      <Chip
        color="warning"
        size="sm"
        variant="flat"
        role="status"
        data-test="notification-permission-denied"
      >
        {t('notifPermissionBlocked')}
      </Chip>
    )
  }

  return null
}
