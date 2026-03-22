import {
  Button,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Switch,
} from '@heroui/react'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import type { TFunction } from 'i18next'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'
import { getChannelPerms } from '@/features/settings'
import type { ChannelResponse } from '@/lib/api'
import { client } from '@/lib/api/client.gen'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'
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
  const { t: tSettings } = useTranslation('settings')
  const queryClient = useQueryClient()
  const updateChannel = useUpdateChannel(serverId, channel.id)
  const schema = editChannelSchema(t)

  /** WHY: Read extended fields from the API response until SDK regeneration. */
  const perms = getChannelPerms(channel)
  const [isPrivate, setIsPrivate] = useState(perms.isPrivate)
  const [isReadOnly, setIsReadOnly] = useState(perms.isReadOnly)

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
    /**
     * WHY: UpdateChannelRequest in the SDK doesn't include is_private/is_read_only yet.
     * Use the raw client to send all fields together.
     */
    client
      .patch({
        url: '/v1/servers/{id}/channels/{channel_id}',
        path: { id: serverId, channel_id: channel.id },
        body: {
          name: values.name,
          topic: values.topic || null,
          is_private: isPrivate,
          is_read_only: isReadOnly,
        },
        headers: { 'Content-Type': 'application/json' },
        security: [{ scheme: 'bearer', type: 'http' }],
      })
      .then(({ error }) => {
        if (error) {
          logger.error('Failed to update channel', { error: String(error) })
          return
        }
        queryClient.invalidateQueries({ queryKey: queryKeys.channels.byServer(serverId) })
        reset()
        onClose()
      })
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
            <Switch
              isSelected={isPrivate}
              onValueChange={setIsPrivate}
              size="sm"
              data-test="edit-channel-private-toggle"
            >
              <div>
                <span className="text-sm">{tSettings('privateChannelLabel')}</span>
                <p className="text-xs text-default-400">{tSettings('privateChannelHelp')}</p>
              </div>
            </Switch>
            <Switch
              isSelected={isReadOnly}
              onValueChange={setIsReadOnly}
              size="sm"
              data-test="edit-channel-readonly-toggle"
            >
              <div>
                <span className="text-sm">{tSettings('readOnlyChannelLabel')}</span>
                <p className="text-xs text-default-400">{tSettings('readOnlyChannelHelp')}</p>
              </div>
            </Switch>
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
