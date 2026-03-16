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
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import type { ChannelResponse } from '@/lib/api'
import { useUpdateChannel } from './hooks/use-update-channel'

const editChannelSchema = z.object({
  name: z
    .string()
    .min(1, 'Channel name is required')
    .max(100, 'Channel name must be 100 characters or less')
    .regex(/^[a-z0-9-]+$/, 'Only lowercase letters, numbers, and hyphens allowed'),
  topic: z.string().max(1024, 'Topic must be 1024 characters or less'),
})

type EditChannelForm = z.infer<typeof editChannelSchema>

interface EditChannelDialogProps {
  channel: ChannelResponse
  serverId: string
  isOpen: boolean
  onClose: () => void
}

export function EditChannelDialog({ channel, serverId, isOpen, onClose }: EditChannelDialogProps) {
  const updateChannel = useUpdateChannel(serverId, channel.id)
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<EditChannelForm>({
    resolver: zodResolver(editChannelSchema),
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
          <ModalHeader>Edit Channel</ModalHeader>
          <ModalBody>
            <Input
              label="Channel name"
              placeholder="channel-name"
              isInvalid={errors.name !== undefined}
              errorMessage={errors.name?.message}
              autoFocus
              data-test="edit-channel-name-input"
              {...register('name')}
            />
            <Input
              label="Topic"
              placeholder="What's this channel about?"
              isInvalid={errors.topic !== undefined}
              errorMessage={errors.topic?.message}
              data-test="edit-channel-topic-input"
              {...register('topic')}
            />
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={handleClose} data-test="edit-channel-cancel-button">
              Cancel
            </Button>
            <Button
              type="submit"
              color="primary"
              isLoading={updateChannel.isPending}
              data-test="edit-channel-submit-button"
            >
              Save
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  )
}
