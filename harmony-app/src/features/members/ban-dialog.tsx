import {
  Button,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Textarea,
} from '@heroui/react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useBanMember } from './hooks/use-ban-member'

interface BanDialogProps {
  isOpen: boolean
  onClose: () => void
  serverId: string
  targetUser: { id: string; username: string }
  serverName: string
}

export function BanDialog({ isOpen, onClose, serverId, targetUser, serverName }: BanDialogProps) {
  const { t } = useTranslation('members')
  const banMember = useBanMember(serverId)
  const [reason, setReason] = useState('')

  function handleClose() {
    setReason('')
    onClose()
  }

  function handleSubmit() {
    banMember.mutate(
      {
        userId: targetUser.id,
        reason: reason.trim().length > 0 ? reason.trim() : undefined,
      },
      {
        onSuccess: () => {
          handleClose()
        },
      },
    )
  }

  return (
    <Modal isOpen={isOpen} onClose={handleClose} size="sm" data-test="ban-dialog">
      <ModalContent>
        <ModalHeader>{t('banUser', { username: targetUser.username })}</ModalHeader>
        <ModalBody>
          <p className="text-sm text-default-600">
            {t('banConfirmation', { username: targetUser.username, serverName })}
          </p>
          <Textarea
            label={t('banReason')}
            placeholder={t('banReasonPlaceholder')}
            maxLength={512}
            value={reason}
            onValueChange={setReason}
            minRows={2}
            maxRows={4}
            data-test="ban-reason-input"
          />
          {banMember.isError && (
            <p className="text-sm text-danger" data-test="ban-error">
              {t('banFailed')}
            </p>
          )}
        </ModalBody>
        <ModalFooter>
          <Button variant="light" onPress={handleClose} data-test="ban-cancel-button">
            {t('common:cancel')}
          </Button>
          <Button
            color="danger"
            onPress={handleSubmit}
            isLoading={banMember.isPending}
            data-test="ban-submit-button"
          >
            {t('banAction')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
}
