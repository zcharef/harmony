/**
 * Informational banner for plaintext DM conversations.
 *
 * WHY: Two distinct plaintext scenarios need disclosure, each with its own copy:
 *  - "web": the local user is on the web client, which cannot encrypt. Copy nudges
 *    them to the desktop app and shows a download CTA.
 *  - "recipient-keyless": the local user is on desktop, but the RECIPIENT has no keys
 *    yet, so the DM falls back to plaintext. The download CTA would be misleading
 *    (the user already has the desktop app), so it is omitted and the copy points at
 *    the recipient instead of the sender.
 *
 * This is a soft CTA — informational, not blocking — unlike EncryptionRequiredBanner
 * which blocks interaction entirely.
 */

import { Chip } from '@heroui/react'
import { LockOpen, Monitor } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { EXTERNAL_LINKS } from '@/lib/external-links'
import { openExternalUrl } from '@/lib/platform'

type DmPlaintextBannerVariant = 'web' | 'recipient-keyless'

export function DmPlaintextBanner({ variant = 'web' }: { variant?: DmPlaintextBannerVariant }) {
  const { t } = useTranslation('crypto')
  const isRecipientKeyless = variant === 'recipient-keyless'

  return (
    <div
      data-test="dm-plaintext-banner"
      className="flex flex-col items-center gap-2 rounded-lg border border-divider bg-default-50 p-4 text-center"
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-warning/10">
        <LockOpen className="h-5 w-5 text-warning" />
      </div>
      <p className="max-w-sm text-sm text-default-500">
        {isRecipientKeyless ? t('dmDesktopRecipientKeyless') : t('dmWebPlaintext')}
      </p>
      {isRecipientKeyless === false && (
        <div className="flex items-center gap-2">
          <Chip
            startContent={<Monitor className="ml-1 h-3.5 w-3.5" />}
            variant="flat"
            color="primary"
            size="sm"
            className="cursor-pointer"
            onClick={() => openExternalUrl(EXTERNAL_LINKS.GITHUB_RELEASES)}
          >
            {t('downloadDesktop')}
          </Chip>
        </div>
      )}
    </div>
  )
}
