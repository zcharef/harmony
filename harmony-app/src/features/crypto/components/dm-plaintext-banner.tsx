/**
 * Informational banner for DM conversations on the web client.
 *
 * WHY: Web users CAN send plaintext DMs, but they should know messages
 * are not encrypted. This is a soft CTA — informational, not blocking —
 * unlike EncryptionRequiredBanner which blocks interaction entirely.
 */

import { Chip } from '@heroui/react'
import { LockOpen, Monitor } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { openExternalUrl } from '@/lib/platform'

const RELEASES_URL = 'https://github.com/zcharef/harmony/releases'

export function DmPlaintextBanner() {
  const { t } = useTranslation('crypto')

  return (
    <div
      data-test="dm-plaintext-banner"
      className="flex flex-col items-center gap-2 rounded-lg border border-divider bg-default-50 p-4 text-center"
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-warning/10">
        <LockOpen className="h-5 w-5 text-warning" />
      </div>
      <p className="max-w-sm text-sm text-default-500">{t('dmWebPlaintext')}</p>
      <div className="flex items-center gap-2">
        <Chip
          startContent={<Monitor className="ml-1 h-3.5 w-3.5" />}
          variant="flat"
          color="primary"
          size="sm"
          className="cursor-pointer"
          onClick={() => openExternalUrl(RELEASES_URL)}
        >
          {t('downloadDesktop')}
        </Chip>
      </div>
    </div>
  )
}
