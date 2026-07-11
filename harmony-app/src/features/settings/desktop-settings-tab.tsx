import { Switch } from '@heroui/react'
import { useTranslation } from 'react-i18next'
import { useAutostart } from './hooks/use-autostart'
import { useDesktopSettingsStore } from './stores/desktop-settings-store'

/**
 * Desktop tab of the User Settings modal — Tauri-only shell behaviors.
 * Rendered only inside the desktop app (isTauri gate in user-settings-modal).
 *
 * Close-to-tray reads straight from the zustand store (no useState shadow,
 * ADR-045); autostart reads the OS registry via use-autostart.
 */
export function DesktopSettingsTab() {
  const { t } = useTranslation('settings')
  const closeToTray = useDesktopSettingsStore((s) => s.closeToTray)
  const setCloseToTray = useDesktopSettingsStore((s) => s.setCloseToTray)
  const autostart = useAutostart()

  return (
    <div className="flex flex-col gap-4 py-2" data-test="desktop-settings-tab">
      <Switch
        isSelected={closeToTray}
        onValueChange={setCloseToTray}
        data-test="desktop-close-to-tray-switch"
      >
        <div className="flex flex-col">
          <span>{t('desktopCloseToTrayLabel')}</span>
          <span className="text-xs text-default-500">{t('desktopCloseToTrayHelp')}</span>
        </div>
      </Switch>

      <Switch
        isSelected={autostart.isEnabled}
        onValueChange={autostart.toggle}
        isDisabled={autostart.isPending}
        data-test="desktop-autostart-switch"
      >
        <div className="flex flex-col">
          <span>{t('desktopAutostartLabel')}</span>
          <span className="text-xs text-default-500">{t('desktopAutostartHelp')}</span>
        </div>
      </Switch>
      {autostart.hasError && (
        <p className="text-xs text-danger" data-test="desktop-autostart-error">
          {t('desktopAutostartError')}
        </p>
      )}
    </div>
  )
}
