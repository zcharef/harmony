import { Button, Divider, Input, Textarea } from '@heroui/react'
import { zodResolver } from '@hookform/resolvers/zod'
import type { TFunction } from 'i18next'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'
import { type MemberRole, ROLE_HIERARCHY } from '@/features/members'
import type { ServerResponse } from '@/lib/api'
import { useDeleteServer } from './hooks/use-delete-server'
import { useUpdateServer } from './hooks/use-update-server'

function serverSchema(t: TFunction<'settings'>) {
  return z.object({
    name: z.string().min(1, t('serverNameRequired')).max(100, t('serverNameMaxLength')),
    description: z.string().max(500, t('descriptionMaxLength')),
  })
}

type ServerForm = z.infer<ReturnType<typeof serverSchema>>

interface OverviewTabProps {
  server: ServerResponse
  callerRole: MemberRole
  onServerDeleted: () => void
}

function DeleteServerSection({
  server,
  onServerDeleted,
}: {
  server: ServerResponse
  onServerDeleted: () => void
}) {
  const { t } = useTranslation('settings')
  const deleteServer = useDeleteServer()
  const [confirmName, setConfirmName] = useState('')

  const canDelete = confirmName === server.name

  function handleDelete() {
    if (!canDelete) return
    deleteServer.mutate(server.id, {
      onSuccess: () => {
        onServerDeleted()
      },
    })
  }

  return (
    <div className="rounded-lg border border-danger-200 p-4">
      <h3 className="text-lg font-semibold text-danger">{t('dangerZone')}</h3>
      <p className="mt-1 text-sm text-default-500">{t('deleteServerWarning')}</p>
      <p className="mt-3 text-sm text-default-600">
        {t('deleteServerConfirmPrompt', { serverName: server.name })}
      </p>
      <Input
        className="mt-2 max-w-sm"
        placeholder={server.name}
        value={confirmName}
        onValueChange={setConfirmName}
        data-test="delete-server-confirm-input"
      />
      <Button
        color="danger"
        className="mt-3"
        isDisabled={!canDelete}
        isLoading={deleteServer.isPending}
        onPress={handleDelete}
        data-test="delete-server-button"
      >
        {t('deleteServer')}
      </Button>
    </div>
  )
}

export function OverviewTab({ server, callerRole, onServerDeleted }: OverviewTabProps) {
  const { t } = useTranslation('settings')
  const updateServer = useUpdateServer(server.id)
  const schema = serverSchema(t)
  const isAdmin = ROLE_HIERARCHY[callerRole] >= ROLE_HIERARCHY.admin

  const {
    register,
    handleSubmit,
    formState: { errors, isDirty },
  } = useForm<ServerForm>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: server.name,
      description: '',
    },
  })

  function onSubmit(values: ServerForm) {
    updateServer.mutate({
      name: values.name,
      description: values.description || null,
    })
  }

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-semibold text-foreground">{t('serverOverview')}</h2>
        <p className="mt-1 text-sm text-default-500">
          {isAdmin ? t('serverOverviewDescription') : t('readOnlyOverviewDescription')}
        </p>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="max-w-lg space-y-4">
        <Input
          label={t('serverName')}
          isReadOnly={isAdmin === false}
          isInvalid={errors.name !== undefined}
          errorMessage={errors.name?.message}
          data-test="settings-server-name-input"
          {...register('name')}
        />
        <Textarea
          label={t('serverDescription')}
          placeholder={t('serverDescriptionPlaceholder')}
          isReadOnly={isAdmin === false}
          isInvalid={errors.description !== undefined}
          errorMessage={errors.description?.message}
          minRows={3}
          maxRows={6}
          data-test="settings-server-description-input"
          {...register('description')}
        />
        {isAdmin && (
          <Button
            type="submit"
            color="primary"
            isLoading={updateServer.isPending}
            isDisabled={isDirty === false}
            data-test="settings-save-overview-button"
          >
            {t('common:save')}
          </Button>
        )}
      </form>

      {callerRole === 'owner' && (
        <>
          <Divider />
          <DeleteServerSection server={server} onServerDeleted={onServerDeleted} />
        </>
      )}
    </div>
  )
}
