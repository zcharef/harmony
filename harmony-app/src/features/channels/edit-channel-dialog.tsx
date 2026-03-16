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
import type { ChannelResponse } from '@/lib/api'
import { useUpdateChannel } from './hooks/use-update-channel'

function editChannelSchema(t: TFunction<'channels'>) {
  return z.object({
    name: z
      .string()
      .min(1, t('channelNameRequired'))
      .max(100, t('channelNameMaxLength'))
      .regex(/^[a-z0-9-]+$/, t('channelNamePattern')),
    topic: z.string().max(1024, t('topicMaxLength')),
  })
}

type EditChannelForm = z.infer<ReturnType<typeof editChannelSchema>>

interface EditChannelDialogProps {
  channel: ChannelResponse
  serverId: string
  isOpen: boolean
  onClose: () => void
}

export function EditChannelDialog({ channel, serverId, isOpen, onClose }: EditChannelDialogProps) {
  const { t } = useTranslation('channels')
  const updateChannel = useUpdateChannel(serverId, channel.id)
  const schema = editChannelSchema(t)
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<EditChannelForm>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: channel.name,
      topic: channel.topic ?? '',
    },
  })

  function onSubmit(values: EditChannelForm) {
    updateChannel.mutate(
      { name: values.name, topic: values.topic || null },
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
    <Modal isOpen={isOpen} onClose={handleClose} size="sm" data-test="edit-channel-dialog">
      <ModalContent>
        <form onSubmit={handleSubmit(onSubmit)}>
          <ModalHeader>{t('editChannel')}</ModalHeader>
          <ModalBody>
            <Input
              label={t('channelName')}
              placeholder={t('channelNamePlaceholder')}
              isInvalid={errors.name !== undefined}
              errorMessage={errors.name?.message}
              autoFocus
              data-test="edit-channel-name-input"
              {...register('name')}
            />
            <Input
              label={t('topic')}
              placeholder={t('topicPlaceholder')}
              isInvalid={errors.topic !== undefined}
              errorMessage={errors.topic?.message}
              data-test="edit-channel-topic-input"
              {...register('topic')}
            />
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={handleClose} data-test="edit-channel-cancel-button">
              {t('common:cancel')}
            </Button>
            <Button
              type="submit"
              color="primary"
              isLoading={updateChannel.isPending}
              data-test="edit-channel-submit-button"
            >
              {t('common:save')}
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  )
}
