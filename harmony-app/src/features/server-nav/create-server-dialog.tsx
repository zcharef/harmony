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

type CreateServerFormValues = z.infer<ReturnType<typeof createServerSchema>>

interface CreateServerFormProps {
  onCreated: (serverId: string) => void
  /** Secondary action — closes the standalone dialog, or steps back to the chooser inside AddServerDialog. */
  onCancel: () => void
  cancelLabel: string
}

/**
 * Presentational create-server step: ModalHeader/Body/Footer only (no <Modal>
 * wrapper), so it can be embedded either in the standalone CreateServerDialog
 * or as the `create` step of AddServerDialog. Feature-internal — not exported
 * from the barrel.
 */
export function CreateServerForm({ onCreated, onCancel, cancelLabel }: CreateServerFormProps) {
  const { t } = useTranslation('servers')
  const createServer = useCreateServer()
  const schema = createServerSchema(t)
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<CreateServerFormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: '' },
  })

  function onSubmit(values: CreateServerFormValues) {
    createServer.mutate(values, {
      onSuccess: (data) => {
        onCreated(data.id)
      },
    })
  }

  return (
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
        <Button variant="light" onPress={onCancel} data-test="create-server-cancel-button">
          {cancelLabel}
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
  )
}

interface CreateServerDialogProps {
  isOpen: boolean
  onClose: () => void
  onCreated: (serverId: string) => void
}

/**
 * Standalone create-server modal. Kept for the flows that open server creation
 * directly (onboarding, discovery empty-state) — the server rail's "+" uses
 * AddServerDialog instead.
 */
export function CreateServerDialog({ isOpen, onClose, onCreated }: CreateServerDialogProps) {
  const { t } = useTranslation('servers')

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="sm" data-test="create-server-dialog">
      <ModalContent>
        <CreateServerForm
          onCreated={(serverId) => {
            onClose()
            onCreated(serverId)
          }}
          onCancel={onClose}
          cancelLabel={t('common:cancel')}
        />
      </ModalContent>
    </Modal>
  )
}
