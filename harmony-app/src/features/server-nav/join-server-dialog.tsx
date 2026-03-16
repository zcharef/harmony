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
import { useMutation } from '@tanstack/react-query'
import type { TFunction } from 'i18next'
import { Users } from 'lucide-react'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'
import type { InvitePreviewResponse } from '@/lib/api'
import { previewInvite } from '@/lib/api'
import { useJoinServer } from './hooks/use-join-server'

function inviteCodeSchema(t: TFunction<'servers'>) {
  return z.object({
    code: z.string().min(1, t('inviteCodeRequired')),
  })
}

type InviteCodeForm = z.infer<ReturnType<typeof inviteCodeSchema>>

interface JoinServerDialogProps {
  isOpen: boolean
  onClose: () => void
  onJoined: () => void
}

export function JoinServerDialog({ isOpen, onClose, onJoined }: JoinServerDialogProps) {
  const { t } = useTranslation('servers')
  const [preview, setPreview] = useState<InvitePreviewResponse | null>(null)
  const [previewCode, setPreviewCode] = useState('')
  const joinServer = useJoinServer()
  const schema = inviteCodeSchema(t)

  const previewMutation = useMutation({
    mutationFn: async (code: string) => {
      const { data } = await previewInvite({
        path: { code },
        throwOnError: true,
      })
      return data
    },
  })

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<InviteCodeForm>({
    resolver: zodResolver(schema),
    defaultValues: { code: '' },
  })

  function onPreview(values: InviteCodeForm) {
    const code = values.code.trim()
    setPreviewCode(code)
    previewMutation.mutate(code, {
      onSuccess: (data) => {
        setPreview(data)
      },
    })
  }

  function onJoin() {
    if (preview === null) return

    // WHY: preview response now includes serverId, body type from OpenAPI SSoT.
    joinServer.mutate(
      { serverId: preview.serverId, body: { inviteCode: previewCode } },
      {
        onSuccess: () => {
          handleClose()
          onJoined()
        },
      },
    )
  }

  function handleClose() {
    reset()
    setPreview(null)
    setPreviewCode('')
    previewMutation.reset()
    joinServer.reset()
    onClose()
  }

  function handleBack() {
    setPreview(null)
    setPreviewCode('')
    previewMutation.reset()
  }

  return (
    <Modal isOpen={isOpen} onClose={handleClose} size="sm" data-test="join-server-dialog">
      <ModalContent>
        {preview !== null ? (
          <>
            <ModalHeader>{t('joinServerTitle')}</ModalHeader>
            <ModalBody>
              <div className="flex flex-col items-center gap-3 py-2">
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary">
                  <span className="text-2xl font-bold text-primary-foreground">
                    {preview.serverName
                      .split(' ')
                      .map((w) => w[0])
                      .join('')
                      .slice(0, 2)
                      .toUpperCase()}
                  </span>
                </div>
                <span
                  className="text-lg font-semibold text-foreground"
                  data-test="join-server-name"
                >
                  {preview.serverName}
                </span>
                <div className="flex items-center gap-1.5 text-sm text-default-500">
                  <Users className="h-4 w-4" />
                  <span data-test="join-server-member-count">
                    {t('memberCount', { count: preview.memberCount })}
                  </span>
                </div>
              </div>
              {joinServer.isError && (
                <p className="text-center text-sm text-danger" data-test="join-server-error">
                  {t('failedToJoinServer')}
                </p>
              )}
            </ModalBody>
            <ModalFooter>
              <Button variant="light" onPress={handleBack} data-test="join-server-back-button">
                {t('common:back')}
              </Button>
              <Button
                color="primary"
                onPress={onJoin}
                isLoading={joinServer.isPending}
                data-test="join-server-confirm-button"
              >
                {t('common:join')}
              </Button>
            </ModalFooter>
          </>
        ) : (
          <form onSubmit={handleSubmit(onPreview)}>
            <ModalHeader>{t('joinServer')}</ModalHeader>
            <ModalBody>
              <Input
                label={t('inviteCode')}
                placeholder={t('inviteCodePlaceholder')}
                isInvalid={errors.code !== undefined || previewMutation.isError}
                errorMessage={
                  errors.code?.message ??
                  (previewMutation.isError ? t('inviteNotFound') : undefined)
                }
                autoFocus
                data-test="invite-code-input"
                {...register('code')}
              />
            </ModalBody>
            <ModalFooter>
              <Button variant="light" onPress={handleClose} data-test="join-server-cancel-button">
                {t('common:cancel')}
              </Button>
              <Button
                type="submit"
                color="primary"
                isLoading={previewMutation.isPending}
                data-test="join-server-preview-button"
              >
                {t('common:preview')}
              </Button>
            </ModalFooter>
          </form>
        )}
      </ModalContent>
    </Modal>
  )
}
