import {
  Button,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
} from '@heroui/react'
import { zodResolver } from '@hookform/resolvers/zod'
import type { TFunction } from 'i18next'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'
import { useCreateServer } from './hooks/use-create-server'

function createServerSchema(t: TFunction<'servers'>) {
  return z.object({
    name: z.string().min(1, t('serverNameRequired')).max(100),
  })
}

type CreateServerForm = z.infer<ReturnType<typeof createServerSchema>>

interface CreateServerDialogProps {
  isOpen: boolean
  onClose: () => void
  onCreated: (serverId: string) => void
}

export function CreateServerDialog({ isOpen, onClose, onCreated }: CreateServerDialogProps) {
  const { t } = useTranslation('servers')
  const createServer = useCreateServer()
  const schema = createServerSchema(t)
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<CreateServerForm>({
    resolver: zodResolver(schema),
    defaultValues: { name: '' },
  })

  function onSubmit(values: CreateServerForm) {
    createServer.mutate(values, {
      onSuccess: (data) => {
        reset()
        onClose()
        onCreated(data.id)
      },
    })
  }

  function handleClose() {
    reset()
    onClose()
  }

  return (
    <Modal isOpen={isOpen} onClose={handleClose} size="sm" data-test="create-server-dialog">
      <ModalContent>
        <form onSubmit={handleSubmit(onSubmit)}>
          <ModalHeader>{t('createServer')}</ModalHeader>
          <ModalBody>
            <Input
              label={t('serverName')}
              placeholder={t('serverNamePlaceholder')}
              isInvalid={errors.name !== undefined}
              errorMessage={errors.name?.message}
              autoFocus
              data-test="server-name-input"
              {...register('name')}
            />
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={handleClose} data-test="create-server-cancel-button">
              {t('common:cancel')}
            </Button>
            <Button
              type="submit"
              color="primary"
              isLoading={createServer.isPending}
              data-test="create-server-submit-button"
            >
              {t('common:create')}
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  )
}
