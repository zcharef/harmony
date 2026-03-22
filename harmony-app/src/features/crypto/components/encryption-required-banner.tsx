/**
 * Web fallback banner for E2EE DM conversations.
 *
 * WHY: DM messages are end-to-end encrypted and can only be decrypted
 * by the Tauri desktop app (vodozemac + SQLCipher). When viewing a DM
 * on the web client, this banner replaces the unreadable ciphertext
 * with a clear explanation and download prompt.
 *
 * Follows the ChatWelcome pattern (src/features/chat/chat-area.tsx:327-368).
 */

import { Chip } from '@heroui/react'
import { Lock, Monitor } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export function EncryptionRequiredBanner() {
  const { t } = useTranslation('crypto')

  return (
    <div data-test="encryption-required-banner" className="flex flex-col items-center gap-3 rounded-lg border border-divider bg-default-50 p-6 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
        <Lock className="h-6 w-6 text-primary" />
      </div>
      <h3 className="text-lg font-semibold text-foreground">{t('encryptedConversation')}</h3>
      <p className="max-w-sm text-sm text-default-500">{t('desktopRequired')}</p>
      <div className="flex items-center gap-2 pt-1">
        <Chip
          startContent={<Monitor className="ml-1 h-3.5 w-3.5" />}
          variant="flat"
          color="primary"
          size="sm"
        >
          {t('downloadDesktop')}
        </Chip>
      </div>
    </div>
  )
}
