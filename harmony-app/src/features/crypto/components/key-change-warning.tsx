/**
 * Identity key change warning banner — shown in DM header when recipient's key changes.
 *
 * WHY: If a recipient's Curve25519 identity key differs from the previously stored one,
 * it may indicate device replacement (benign) or a MITM attack (malicious). The user
 * must be informed so they can verify out-of-band if needed.
 *
 * Displayed inline in the DM chat header area (not a toast — follows ADR-045 inline-first).
 */

import { Chip } from '@heroui/react'
import { ShieldAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface KeyChangeWarningProps {
  recipientName: string
}

export function KeyChangeWarning({ recipientName }: KeyChangeWarningProps) {
  const { t } = useTranslation('crypto')

  return (
    <Chip
      startContent={<ShieldAlert className="ml-1 h-3 w-3" />}
      variant="flat"
      color="warning"
      size="sm"
      className="shrink-0"
    >
      {t('keyChanged', { name: recipientName })}
    </Chip>
  )
}
