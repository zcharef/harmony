import {
  Button,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Radio,
  RadioGroup,
  Switch,
} from '@heroui/react'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import type { TFunction } from 'i18next'
import { Hash, Volume2 } from 'lucide-react'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'
import type { ChannelType } from '@/lib/api'
import { client } from '@/lib/api/client.gen'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'
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
  const { t: tSettings } = useTranslation('settings')
  const queryClient = useQueryClient()
  const createChannel = useCreateChannel(serverId)
  const schema = createChannelSchema(t)
  const [channelType, setChannelType] = useState<ChannelType>('text')
  const [isPrivate, setIsPrivate] = useState(false)
  const [isReadOnly, setIsReadOnly] = useState(false)

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
    /**
     * WHY: CreateChannelRequest in the SDK doesn't include is_private/is_read_only yet.
     * If either flag is set, we use the raw client to send them.
     * Otherwise, use the typed SDK call for safety.
     */
    if (isPrivate || isReadOnly) {
      client
        .post({
          url: '/v1/servers/{id}/channels',
          path: { id: serverId },
          body: {
            name: values.name,
            channelType,
            is_private: isPrivate,
            is_read_only: isReadOnly,
          },
          headers: { 'Content-Type': 'application/json' },
          security: [{ scheme: 'bearer', type: 'http' }],
        })
        .then(({ error }) => {
          if (error) {
            logger.error('Failed to create channel with permissions', { error: String(error) })
            return
          }
          queryClient.invalidateQueries({ queryKey: queryKeys.channels.byServer(serverId) })
          resetAndClose()
        })
      return
    }

    createChannel.mutate(
      { name: values.name, channelType },
      {
        onSuccess: () => {
          resetAndClose()
        },
      },
    )
  }

  function resetAndClose() {
    reset()
    setChannelType('text')
    setIsPrivate(false)
    setIsReadOnly(false)
    onClose()
  }

  function handleClose() {
    resetAndClose()
  }

  return (
    <Modal isOpen={isOpen} onClose={handleClose} size="sm" data-test="create-channel-dialog">
      <ModalContent>
        <form onSubmit={handleSubmit(onSubmit)}>
          <ModalHeader>{t('createChannel')}</ModalHeader>
          <ModalBody>
            <RadioGroup
              label={t('channelType')}
              orientation="horizontal"
              value={channelType}
              onValueChange={(v) => setChannelType(v as ChannelType)}
              size="sm"
              data-test="channel-type-selector"
            >
              <Radio value="text" data-test="channel-type-text">
                <div className="flex items-center gap-1.5">
                  <Hash className="h-3.5 w-3.5" />
                  <span>{t('textChannel')}</span>
                </div>
              </Radio>
              <Radio value="voice" data-test="channel-type-voice">
                <div className="flex items-center gap-1.5">
                  <Volume2 className="h-3.5 w-3.5" />
                  <span>{t('voiceChannel')}</span>
                </div>
              </Radio>
            </RadioGroup>
            <Input
              label={t('channelName')}
              placeholder={t('channelNamePlaceholder')}
              isInvalid={errors.name !== undefined}
              errorMessage={errors.name?.message}
              autoFocus
              data-test="channel-name-input"
              {...register('name')}
            />
            <Switch
              isSelected={isPrivate}
              onValueChange={setIsPrivate}
              size="sm"
              data-test="create-channel-private-toggle"
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
              data-test="create-channel-readonly-toggle"
            >
              <div>
                <span className="text-sm">{tSettings('readOnlyChannelLabel')}</span>
                <p className="text-xs text-default-400">{tSettings('readOnlyChannelHelp')}</p>
              </div>
            </Switch>
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
