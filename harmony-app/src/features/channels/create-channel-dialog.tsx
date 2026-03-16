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
import { useCreateChannel } from './hooks/use-create-channel'

const createChannelSchema = z.object({
  name: z
    .string()
    .min(1, 'Channel name is required')
    .max(100, 'Channel name must be 100 characters or less')
    .regex(/^[a-z0-9-]+$/, 'Only lowercase letters, numbers, and hyphens allowed'),
})

type CreateChannelForm = z.infer<typeof createChannelSchema>

interface CreateChannelDialogProps {
  serverId: string
  isOpen: boolean
  onClose: () => void
}

export function CreateChannelDialog({ serverId, isOpen, onClose }: CreateChannelDialogProps) {
  const createChannel = useCreateChannel(serverId)
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<CreateChannelForm>({
    resolver: zodResolver(createChannelSchema),
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
          <ModalHeader>Create Channel</ModalHeader>
          <ModalBody>
            <Input
              label="Channel name"
              placeholder="new-channel"
              isInvalid={errors.name !== undefined}
              errorMessage={errors.name?.message}
              autoFocus
              data-test="channel-name-input"
              {...register('name')}
            />
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={handleClose} data-test="create-channel-cancel-button">
              Cancel
            </Button>
            <Button
              type="submit"
              color="primary"
              isLoading={createChannel.isPending}
              data-test="create-channel-submit-button"
            >
              Create
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  )
}
