import { Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@heroui/react'
import { useTranslation } from 'react-i18next'
import { useKickMember } from './hooks/use-kick-member'

interface KickDialogProps {
  isOpen: boolean
  onClose: () => void
  serverId: string
  targetUser: { id: string; username: string }
  serverName: string
}

export function KickDialog({ isOpen, onClose, serverId, targetUser, serverName }: KickDialogProps) {
  const { t } = useTranslation('members')
  const kickMember = useKickMember(serverId)

  function handleSubmit() {
    kickMember.mutate(targetUser.id, {
      onSuccess: () => {
        onClose()
      },
    })
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="sm" data-test="kick-dialog">
      <ModalContent>
        <ModalHeader>{t('kickUser', { username: targetUser.username })}</ModalHeader>
        <ModalBody>
          <p className="text-sm text-default-600">
            {t('kickConfirmation', { username: targetUser.username, serverName })}
          </p>
          {kickMember.isError && (
            <p className="text-sm text-danger" data-test="kick-error">
              {t('kickFailed')}
            </p>
          )}
        </ModalBody>
        <ModalFooter>
          <Button variant="light" onPress={onClose} data-test="kick-cancel-button">
            {t('common:cancel')}
          </Button>
          <Button
            color="danger"
            onPress={handleSubmit}
            isLoading={kickMember.isPending}
            data-test="kick-submit-button"
          >
            {t('kickAction')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
}
