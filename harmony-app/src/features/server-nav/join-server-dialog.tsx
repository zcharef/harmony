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
import { getInviteCodeFromInput } from '@/lib/invite-path'
import { useJoinServer } from './hooks/use-join-server'

function inviteCodeSchema(t: TFunction<'servers'>) {
  return z.object({
    code: z.string().min(1, t('inviteCodeRequired')),
  })
}

type InviteCodeForm = z.infer<ReturnType<typeof inviteCodeSchema>>

interface JoinServerFormProps {
  onJoined: (serverId: string) => void
  /** Secondary action on the code-entry phase — closes the standalone dialog, or steps back to the chooser inside AddServerDialog. */
  onCancel: () => void
  cancelLabel: string
}

/**
 * Presentational join-server step: ModalHeader/Body/Footer only (no <Modal>
 * wrapper). Two phases — invite-link/code entry → server preview → confirm —
 * with an internal Back link (preview → entry). Accepts a pasted invite link or
 * a bare code (getInviteCodeFromInput). Feature-internal — not exported from
 * the barrel.
 */
export function JoinServerForm({ onJoined, onCancel, cancelLabel }: JoinServerFormProps) {
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
    formState: { errors },
  } = useForm<InviteCodeForm>({
    resolver: zodResolver(schema),
    defaultValues: { code: '' },
  })

  function onPreview(values: InviteCodeForm) {
    const code = getInviteCodeFromInput(values.code)
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
          onJoined(preview.serverId)
        },
      },
    )
  }

  // WHY internal back: returns from the preview card to the code-entry phase.
  // The chooser-level Back (onCancel) is a separate action on the entry phase.
  function handleBackToEntry() {
    setPreview(null)
    setPreviewCode('')
    previewMutation.reset()
    // WHY reset the join mutation too: otherwise a failed join leaves isError
    // set, and the stale "failed to join" banner would flash on the next preview.
    joinServer.reset()
  }

  if (preview !== null) {
    return (
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
            <span className="text-lg font-semibold text-foreground" data-test="join-server-name">
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
          <Button variant="light" onPress={handleBackToEntry} data-test="join-server-back-button">
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
    )
  }

  return (
    <form onSubmit={handleSubmit(onPreview)}>
      <ModalHeader>{t('joinServer')}</ModalHeader>
      <ModalBody>
        <Input
          label={t('inviteLinkOrCode')}
          placeholder={t('inviteLinkOrCodePlaceholder')}
          isInvalid={errors.code !== undefined || previewMutation.isError}
          errorMessage={
            errors.code?.message ?? (previewMutation.isError ? t('inviteNotFound') : undefined)
          }
          autoFocus
          data-test="invite-code-input"
          {...register('code')}
        />
      </ModalBody>
      <ModalFooter>
        <Button variant="light" onPress={onCancel} data-test="join-server-cancel-button">
          {cancelLabel}
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
  )
}

interface JoinServerDialogProps {
  isOpen: boolean
  onClose: () => void
  onJoined: (serverId: string) => void
}

/**
 * Standalone join-server modal. Kept for the flows that open joining directly
 * (onboarding) — the server rail's "+" uses AddServerDialog instead.
 */
export function JoinServerDialog({ isOpen, onClose, onJoined }: JoinServerDialogProps) {
  const { t } = useTranslation('servers')

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="sm" data-test="join-server-dialog">
      <ModalContent>
        <JoinServerForm
          onJoined={(serverId) => {
            onClose()
            onJoined(serverId)
          }}
          onCancel={onClose}
          cancelLabel={t('common:cancel')}
        />
      </ModalContent>
    </Modal>
  )
}
