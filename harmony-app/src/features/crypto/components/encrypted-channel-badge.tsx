/**
 * Encrypted channel lock icon — shown next to channel names in the sidebar.
 *
 * WHY: Visual indicator that a channel has Megolm E2EE enabled. Users need
 * to know which channels are encrypted at a glance. Uses the same Lock icon
 * already used for private channels but with a distinct tooltip and color.
 *
 * Follows the existing icon pattern in ChannelButton (channel-sidebar.tsx:66-73).
 */

import { Tooltip } from '@heroui/react'
import { Lock } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export function EncryptedChannelBadge() {
  const { t } = useTranslation('crypto')

  return (
    <Tooltip content={t('encryptionEnabled')} placement="top" delay={300}>
      <Lock className="h-3 w-3 shrink-0 text-success" data-test="encrypted-channel-badge" />
    </Tooltip>
  )
}
