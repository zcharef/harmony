/**
 * Modal prompt shown when a new app version is downloaded and ready to install.
 *
 * WHY: Tauri auto-update downloads in the background. When the app is already
 * open, we prompt the user to restart rather than interrupting their session.
 * Uses a modal instead of a toast because this is a deliberate decision point:
 * the user should choose "now" or "not now" without the prompt auto-dismissing.
 */

import { Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@heroui/react'
import { Download } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface UpdateNotificationProps {
  version: string
  currentVersion: string
  body: string | null
  onRestart: () => void
  onDismiss: () => void
}

export function UpdateNotification({
  version,
  currentVersion,
  body,
  onRestart,
  onDismiss,
}: UpdateNotificationProps) {
  const { t } = useTranslation('common')

  return (
    <Modal isOpen onClose={onDismiss} hideCloseButton size="md">
      <ModalContent>
        <ModalHeader className="flex items-center gap-2">
          <Download className="h-5 w-5 text-success" />
          {t('updateTitle')}
        </ModalHeader>
        <ModalBody>
          <p className="text-sm text-foreground-500">
            {t('updateVersionTransition', { from: currentVersion, to: version })}
          </p>
          {body !== null && body.length > 0 && (
            <div className="mt-2 max-h-40 overflow-y-auto rounded-lg bg-default-100 p-3">
              <p className="whitespace-pre-line text-sm text-foreground-600">{body}</p>
            </div>
          )}
        </ModalBody>
        <ModalFooter>
          <Button variant="light" onPress={onDismiss}>
            {t('updateDismiss')}
          </Button>
          <Button color="success" onPress={onRestart}>
            {t('updateAction')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
}
