/**
 * E2EE alpha disclaimer banner — shown in DM conversations on desktop.
 *
 * WHY: The E2EE implementation is experimental and has not been security-audited.
 * Users must be aware that the encryption is not yet production-grade.
 * Follows the AlphaBadge pattern (src/components/layout/main-layout.tsx:18-32).
 */

import { Chip } from '@heroui/react'
import { ShieldAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export function E2eeAlphaBanner() {
  const { t } = useTranslation('crypto')

  return (
    <Chip
      data-test="e2ee-alpha-banner"
      startContent={<ShieldAlert className="ml-1 h-3 w-3" />}
      variant="flat"
      color="warning"
      size="sm"
      className="shrink-0"
    >
      {t('e2eeAlpha')}
    </Chip>
  )
}
