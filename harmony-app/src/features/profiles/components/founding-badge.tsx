import { Tooltip } from '@heroui/react'
import { Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'

/**
 * WHY: The founding-member badge — a small icon + tooltip shown next to a
 * founding user's name anywhere identity renders (profile card, member list,
 * message author). Renders nothing for non-founders, so callers can drop it in
 * unconditionally. Pure UI (props only) per the shared-component contract.
 */
export function FoundingBadge({ isFounding }: { isFounding: boolean }) {
  const { t } = useTranslation('profiles')

  if (isFounding === false) return null

  return (
    <Tooltip content={t('foundingTooltip')} size="sm">
      <span data-test="founding-badge" className="inline-flex items-center">
        <Sparkles className="h-3.5 w-3.5 shrink-0 text-warning" aria-label={t('foundingLabel')} />
      </span>
    </Tooltip>
  )
}
