/**
 * Encrypted channel info banner — shown when a user first enters an encrypted channel.
 *
 * WHY: Users joining an encrypted channel need to know:
 * 1. Messages are end-to-end encrypted
 * 2. They can only see messages from when they joined (forward secrecy)
 * 3. The banner is dismissible and persisted in localStorage per channel
 *
 * Follows the EncryptionRequiredBanner pattern (encryption-required-banner.tsx).
 */

import { Button, Chip } from '@heroui/react'
import { Lock, X } from 'lucide-react'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'

const DISMISSED_KEY_PREFIX = 'harmony_encrypted_channel_notice_dismissed_'

interface EncryptedChannelNoticeProps {
  channelId: string
}

export function EncryptedChannelNotice({ channelId }: EncryptedChannelNoticeProps) {
  const { t } = useTranslation('crypto')
  const storageKey = `${DISMISSED_KEY_PREFIX}${channelId}`

  const [isDismissed, setIsDismissed] = useState(() => {
    return localStorage.getItem(storageKey) === 'true'
  })

  const handleDismiss = useCallback(() => {
    localStorage.setItem(storageKey, 'true')
    setIsDismissed(true)
  }, [storageKey])

  if (isDismissed) return null

  return (
    <div
      data-test="encrypted-channel-notice"
      className="mx-4 mt-3 flex items-start gap-3 rounded-lg border border-success/30 bg-success-50 p-3"
    >
      <Chip
        startContent={<Lock className="ml-1 h-3 w-3" />}
        variant="flat"
        color="success"
        size="sm"
        className="shrink-0"
      >
        {t('encryptionEnabled')}
      </Chip>
      <p className="flex-1 text-sm text-default-600">{t('channelEncryptedNotice')}</p>
      <Button
        variant="light"
        isIconOnly
        size="sm"
        onPress={handleDismiss}
        aria-label={t('common:dismiss')}
        className="shrink-0"
        data-test="encrypted-channel-notice-dismiss"
      >
        <X className="h-3.5 w-3.5 text-default-400" />
      </Button>
    </div>
  )
}
