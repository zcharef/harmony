import { Tooltip } from '@heroui/react'
import { BadgeCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'

/**
 * WHY: The "Harmony Official" verified badge — a small icon + tooltip shown next
 * to a verified staff account's name everywhere identity renders (message
 * author, profile card, member list). It prevents impersonation, so it is
 * deliberately distinct from the founding badge: a `BadgeCheck` verified seal in
 * the brand/trust `accent` tone rather than the amber `Sparkles`. Renders
 * nothing for non-official users, so callers can drop it in unconditionally.
 * Pure UI (props only) per the shared-component contract.
 */
export function OfficialBadge({ isOfficial }: { isOfficial: boolean }) {
  const { t } = useTranslation('profiles')

  if (isOfficial === false) return null

  return (
    <Tooltip content={t('officialTooltip')} size="sm">
      <span data-test="official-badge" className="inline-flex items-center">
        <BadgeCheck className="h-3.5 w-3.5 shrink-0 text-accent" aria-label={t('officialLabel')} />
      </span>
    </Tooltip>
  )
}
