import {
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownSection,
  DropdownTrigger,
} from '@heroui/react'
import { Check, EyeOff } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { usePreferences, useUpdatePreferences } from '@/features/preferences'

type StatusOption = 'online' | 'dnd'

const statusDot: Record<StatusOption, string> = {
  online: 'bg-success',
  dnd: 'bg-danger',
}

/**
 * WHY: Discord-style status picker. Click avatar area → dropdown with status options.
 * "Online" disables DND (presence auto-detects idle). "Do Not Disturb" enables DND.
 * Also contains the "Hide Profanity" toggle (client-side content filtering).
 * Wraps children as the dropdown trigger — pass the avatar/username area.
 */
export function StatusPicker({ children }: { children: ReactNode }) {
  const { t } = useTranslation('messages')
  const { data } = usePreferences()
  const updatePreferences = useUpdatePreferences()

  const currentStatus: StatusOption = data?.dndEnabled === true ? 'dnd' : 'online'
  const hideProfanity = data?.hideProfanity ?? true

  function handleSelect(key: string | number) {
    const selected = String(key)

    // WHY: Status options are mutually exclusive (radio), profanity is a toggle (checkbox).
    if (selected === 'hide_profanity') {
      updatePreferences.mutate({ hideProfanity: !hideProfanity })
      return
    }

    if (selected === currentStatus) return

    if (selected === 'dnd') {
      updatePreferences.mutate({ dndEnabled: true })
    } else if (selected === 'online') {
      updatePreferences.mutate({ dndEnabled: false })
    }
  }

  return (
    <Dropdown placement="top-start">
      <DropdownTrigger>
        <button
          type="button"
          className="flex flex-1 cursor-pointer items-center gap-2 rounded-md p-2 transition-colors hover:bg-default-100"
          data-test="status-picker-trigger"
        >
          {children}
        </button>
      </DropdownTrigger>
      <DropdownMenu aria-label={t('preferences.statusPickerLabel')} onAction={handleSelect}>
        <DropdownSection title={t('preferences.setStatus')}>
          <DropdownItem
            key="online"
            startContent={<StatusDot color={statusDot.online} />}
            endContent={
              currentStatus === 'online' ? <Check className="h-4 w-4 text-success" /> : null
            }
          >
            {t('statusOnline')}
          </DropdownItem>
          <DropdownItem
            key="dnd"
            startContent={<StatusDot color={statusDot.dnd} />}
            description={t('preferences.dndDescription')}
            endContent={currentStatus === 'dnd' ? <Check className="h-4 w-4 text-danger" /> : null}
          >
            {t('preferences.dndEnabled')}
          </DropdownItem>
        </DropdownSection>
        <DropdownSection title={t('preferences.contentFiltering')}>
          <DropdownItem
            key="hide_profanity"
            startContent={<EyeOff className="h-4 w-4 text-default-500" />}
            description={t('preferences.hideProfanityDescription')}
            endContent={hideProfanity ? <Check className="h-4 w-4 text-success" /> : null}
            data-test="hide-profanity-toggle"
          >
            {t('preferences.hideProfanity')}
          </DropdownItem>
        </DropdownSection>
      </DropdownMenu>
    </Dropdown>
  )
}

function StatusDot({ color }: { color: string }) {
  return <div className={`${color} h-3 w-3 rounded-full`} />
}
