/**
 * Trust badge — visual indicator on user avatar in DMs.
 *
 * WHY: Shows the verification state of a DM contact at a glance.
 * - Unverified: no badge (default TOFU, most contacts)
 * - Verified: green checkmark (user manually compared safety numbers)
 * - Blocked: red X (user explicitly blocked this contact)
 *
 * Only rendered on desktop (caller must guard with isTauri()).
 */

import { Tooltip } from '@heroui/react'
import { CheckCircle2, XCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TrustLevel } from '@/lib/crypto-cache'

interface TrustBadgeProps {
  trustLevel: TrustLevel
}

export function TrustBadge({ trustLevel }: TrustBadgeProps) {
  const { t } = useTranslation('crypto')

  if (trustLevel === 'unverified') {
    return null
  }

  if (trustLevel === 'verified') {
    return (
      <Tooltip content={t('verified')} size="sm">
        <CheckCircle2 className="h-3.5 w-3.5 text-success" />
      </Tooltip>
    )
  }

  // trustLevel === 'blocked'
  return (
    <Tooltip content={t('blocked')} size="sm">
      <XCircle className="h-3.5 w-3.5 text-danger" />
    </Tooltip>
  )
}
