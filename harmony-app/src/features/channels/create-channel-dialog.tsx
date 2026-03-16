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
import { useCreateChannel } from './hooks/use-create-channel'

function createChannelSchema(t: TFunction<'channels'>) {
  return z.object({
    name: z
      .string()
      .min(1, t('channelNameRequired'))
      .max(100, t('channelNameMaxLength'))
      .regex(/^[a-z0-9-]+$/, t('channelNamePattern')),
  })
}

type CreateChannelForm = z.infer<ReturnType<typeof createChannelSchema>>

interface CreateChannelDialogProps {
  serverId: string
  isOpen: boolean
  onClose: () => void
}

export function CreateChannelDialog({ serverId, isOpen, onClose }: CreateChannelDialogProps) {
  const { t } = useTranslation('channels')
  const createChannel = useCreateChannel(serverId)
  const schema = createChannelSchema(t)
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<CreateChannelForm>({
    resolver: zodResolver(schema),
    defaultValues: { name: '' },
  })

  function onSubmit(values: CreateChannelForm) {
    createChannel.mutate(
      { name: values.name },
      {
        onSuccess: () => {
          reset()
          onClose()
        },
      },
    )
  }

  function handleClose() {
    reset()
    onClose()
  }

  return (
    <Modal isOpen={isOpen} onClose={handleClose} size="sm" data-test="create-channel-dialog">
      <ModalContent>
        <form onSubmit={handleSubmit(onSubmit)}>
          <ModalHeader>{t('createChannel')}</ModalHeader>
          <ModalBody>
            <Input
              label={t('channelName')}
              placeholder={t('channelNamePlaceholder')}
              isInvalid={errors.name !== undefined}
              errorMessage={errors.name?.message}
              autoFocus
              data-test="channel-name-input"
              {...register('name')}
            />
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={handleClose} data-test="create-channel-cancel-button">
              {t('common:cancel')}
            </Button>
            <Button
              type="submit"
              color="primary"
              isLoading={createChannel.isPending}
              data-test="create-channel-submit-button"
            >
              {t('common:create')}
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  )
}
