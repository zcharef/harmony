import { Button, Spinner, Switch } from '@heroui/react'
import { Hash, Plus, Trash2, Volume2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CreateChannelDialog, useChannels, useDeleteChannel } from '@/features/channels'
import type { ChannelResponse } from '@/lib/api'
import { useUpdateChannelPerms } from './hooks/use-update-channel-perms'
import { getChannelPerms } from './settings-types'

function ChannelRow({
  channel,
  serverId,
  onDelete,
}: {
  channel: ChannelResponse
  serverId: string
  onDelete: () => void
}) {
  const { t } = useTranslation('settings')

  /**
   * WHY: The generated ChannelResponse doesn't include isPrivate/isReadOnly yet.
   * We read them safely via getChannelPerms until SDK regeneration.
   */
  const perms = getChannelPerms(channel)
  const [isPrivate, setIsPrivate] = useState(perms.isPrivate)
  const [isReadOnly, setIsReadOnly] = useState(perms.isReadOnly)

  const updatePerms = useUpdateChannelPerms(serverId, channel.id)

  function handlePrivateToggle(value: boolean) {
    setIsPrivate(value)
    updatePerms.mutate({ isPrivate: value })
  }

  function handleReadOnlyToggle(value: boolean) {
    setIsReadOnly(value)
    updatePerms.mutate({ isReadOnly: value })
  }

  return (
    <div
      className="flex items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-default-100"
      data-test="settings-channel-row"
      data-channel-id={channel.id}
    >
      {channel.channelType === 'text' ? (
        <Hash className="h-4 w-4 shrink-0 text-default-500" />
      ) : (
        <Volume2 className="h-4 w-4 shrink-0 text-default-500" />
      )}
      <div className="flex-1 overflow-hidden">
        <span className="truncate text-sm font-medium text-foreground">{channel.name}</span>
        {channel.topic !== undefined && channel.topic !== null && (
          <p className="truncate text-xs text-default-400">{channel.topic}</p>
        )}
      </div>
      <div className="flex items-center gap-4">
        <Switch
          size="sm"
          isSelected={isPrivate}
          onValueChange={handlePrivateToggle}
          aria-label={t('privateChannel')}
          data-test="channel-private-toggle"
        >
          <span className="text-xs text-default-500">{t('private')}</span>
        </Switch>
        <Switch
          size="sm"
          isSelected={isReadOnly}
          onValueChange={handleReadOnlyToggle}
          aria-label={t('readOnlyChannel')}
          data-test="channel-readonly-toggle"
        >
          <span className="text-xs text-default-500">{t('readOnly')}</span>
        </Switch>
        <Button
          variant="light"
          isIconOnly
          size="sm"
          color="danger"
          onPress={onDelete}
          aria-label={t('channels:deleteChannel')}
          data-test="channel-delete-button"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}

interface ChannelsTabProps {
  serverId: string
}

export function ChannelsTab({ serverId }: ChannelsTabProps) {
  const { t } = useTranslation('settings')
  const { data: channels, isPending } = useChannels(serverId)
  const deleteChannel = useDeleteChannel(serverId)
  const [isCreateOpen, setIsCreateOpen] = useState(false)

  function handleDeleteChannel(channel: ChannelResponse) {
    if (window.confirm(t('channels:deleteConfirm', { channelName: channel.name }))) {
      deleteChannel.mutate(channel.id)
    }
  }

  if (isPending) {
    return (
      <div className="flex justify-center py-8">
        <Spinner size="md" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-foreground">{t('channelsTitle')}</h2>
          <p className="mt-1 text-sm text-default-500">{t('channelsDescription')}</p>
        </div>
        <Button
          color="primary"
          startContent={<Plus className="h-4 w-4" />}
          onPress={() => setIsCreateOpen(true)}
          data-test="settings-create-channel-button"
        >
          {t('channels:createChannel')}
        </Button>
      </div>

      <div className="space-y-1">
        {channels?.map((channel) => (
          <ChannelRow
            key={channel.id}
            channel={channel}
            serverId={serverId}
            onDelete={() => handleDeleteChannel(channel)}
          />
        ))}

        {channels !== undefined && channels.length === 0 && (
          <p className="py-8 text-center text-sm text-default-500">{t('channels:noChannelsYet')}</p>
        )}
      </div>

      <CreateChannelDialog
        serverId={serverId}
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
      />
    </div>
  )
}
