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
import { useCreateServer } from './hooks/use-create-server'

const createServerSchema = z.object({
  name: z.string().min(1, 'Server name is required').max(100),
})

type CreateServerForm = z.infer<typeof createServerSchema>

interface CreateServerDialogProps {
  isOpen: boolean
  onClose: () => void
  onCreated: (serverId: string) => void
}

export function CreateServerDialog({ isOpen, onClose, onCreated }: CreateServerDialogProps) {
  const createServer = useCreateServer()
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<CreateServerForm>({
    resolver: zodResolver(createServerSchema),
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
    <Modal isOpen={isOpen} onClose={handleClose} size="sm">
      <ModalContent>
        <form onSubmit={handleSubmit(onSubmit)}>
          <ModalHeader>Create a Server</ModalHeader>
          <ModalBody>
            <Input
              label="Server name"
              placeholder="My Awesome Server"
              isInvalid={errors.name !== undefined}
              errorMessage={errors.name?.message}
              autoFocus
              {...register('name')}
            />
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={handleClose}>
              Cancel
            </Button>
            <Button type="submit" color="primary" isLoading={createServer.isPending}>
              Create
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  )
}
