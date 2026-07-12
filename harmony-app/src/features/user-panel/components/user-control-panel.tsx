import { Avatar, Button, Popover, PopoverContent, PopoverTrigger, Tooltip } from '@heroui/react'
import { ChevronUp, HeadphoneOff, Headphones, Mic, MicOff, Settings } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAuthStore, useCurrentProfile } from '@/features/auth'
import { StatusPicker } from '@/features/preferences'
import { StatusIndicator, useUserStatus } from '@/features/presence'
import { useSettingsUiStore } from '@/features/settings'
import { AudioDeviceSelector, useVoiceConnectionStore } from '@/features/voice'
import { resolveDisplayName } from '@/lib/display-name'

/**
 * WHY a dedicated feature (not features/voice): the panel needs presence's
 * StatusIndicator/useUserStatus, and features/presence already imports
 * features/voice — placing it in voice would create a cycle. It lives here and
 * is consumed by both sidebars (channel + DM), de-duplicating what used to be
 * inlined twice.
 *
 * Discord-style bottom-left user panel: avatar + name/status stacked and
 * left-aligned, then mic/deafen toggles — each with a small device-picker
 * chevron — and the settings gear. Mute/deafen and device selection all work
 * pre-call: the voice store persists the intent and applies it on join.
 */
export function UserControlPanel() {
  const { t } = useTranslation('channels')
  const { t: tVoice } = useTranslation('voice')
  const { t: tSettings } = useTranslation('settings')
  const user = useAuthStore((s) => s.user)
  const { data: profile } = useCurrentProfile()
  const status = useUserStatus(user?.id ?? '')
  const displayName =
    profile !== undefined
      ? resolveDisplayName({ displayName: profile.displayName, username: profile.username })
      : t('youFallback')
  const openUserSettings = useSettingsUiStore((s) => s.openUserSettings)
  const isMuted = useVoiceConnectionStore((s) => s.isMuted)
  const isDeafened = useVoiceConnectionStore((s) => s.isDeafened)
  const toggleMute = useVoiceConnectionStore((s) => s.toggleMute)
  const toggleDeafen = useVoiceConnectionStore((s) => s.toggleDeafen)

  const statusLabels = {
    online: t('statusOnline'),
    idle: t('statusIdle'),
    dnd: t('statusDnd'),
    offline: t('statusOffline'),
  } as const

  return (
    <div
      data-test="user-control-panel"
      className="flex items-center border-t border-divider bg-content1"
    >
      <StatusPicker>
        <div className="relative">
          <Avatar
            name={displayName}
            src={profile?.avatarUrl ?? undefined}
            size="sm"
            color="primary"
            showFallback
            classNames={{
              base: 'h-8 w-8',
              name: 'text-xs text-primary-foreground',
            }}
          />
          <div className="absolute -bottom-0.5 -right-0.5">
            <StatusIndicator status={status} size="lg" />
          </div>
        </div>
        <div className="flex flex-1 flex-col overflow-hidden text-left">
          <span className="truncate text-sm font-medium text-foreground">{displayName}</span>
          <span className="truncate text-xs text-default-500">{statusLabels[status]}</span>
        </div>
      </StatusPicker>
      <div className="flex items-center gap-0.5 pr-2">
        <Tooltip content={isMuted ? tVoice('unmute') : tVoice('mute')} placement="top" delay={300}>
          <Button
            variant="light"
            isIconOnly
            size="sm"
            className="h-8 w-8"
            onPress={toggleMute}
            data-test="voice-mute-btn"
          >
            {isMuted ? (
              <MicOff className="h-4 w-4 text-danger" />
            ) : (
              <Mic className="h-4 w-4 text-default-500" />
            )}
          </Button>
        </Tooltip>
        <DeviceChevron
          kind="audioinput"
          label={tVoice('selectInputDevice')}
          dataTest="voice-input-device-chevron"
        />
        <Tooltip
          content={isDeafened ? tVoice('undeafen') : tVoice('deafen')}
          placement="top"
          delay={300}
        >
          <Button
            variant="light"
            isIconOnly
            size="sm"
            className="h-8 w-8"
            onPress={toggleDeafen}
            data-test="voice-deafen-btn"
          >
            {isDeafened ? (
              <HeadphoneOff className="h-4 w-4 text-danger" />
            ) : (
              <Headphones className="h-4 w-4 text-default-500" />
            )}
          </Button>
        </Tooltip>
        <DeviceChevron
          kind="audiooutput"
          label={tVoice('selectOutputDevice')}
          dataTest="voice-output-device-chevron"
        />
        <Tooltip content={tSettings('userSettingsTooltip')} placement="top" delay={300}>
          <Button
            variant="light"
            isIconOnly
            size="sm"
            className="h-8 w-8"
            onPress={() => openUserSettings()}
            data-test="user-settings-button"
          >
            <Settings className="h-4 w-4 text-default-500" />
          </Button>
        </Tooltip>
      </div>
    </div>
  )
}

/**
 * WHY: A small chevron that opens a single-kind device picker so the user can
 * choose their mic or speaker inline — including before joining a call. The
 * selector persists the choice via the voice store and applies it on join.
 */
function DeviceChevron({
  kind,
  label,
  dataTest,
}: {
  kind: 'audioinput' | 'audiooutput'
  label: string
  dataTest: string
}) {
  // WHY no Tooltip wrapper: PopoverTrigger already clones its single child to
  // wire the trigger ref/handlers — nesting a Tooltip that also clones the same
  // child conflicts. The label is conveyed via aria-label instead.
  return (
    <Popover placement="top" showArrow>
      <PopoverTrigger>
        <Button
          variant="light"
          isIconOnly
          size="sm"
          className="h-8 w-5 min-w-5"
          aria-label={label}
          data-test={dataTest}
        >
          <ChevronUp className="h-3 w-3 text-default-500" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-3">
        <AudioDeviceSelector kind={kind} />
      </PopoverContent>
    </Popover>
  )
}
