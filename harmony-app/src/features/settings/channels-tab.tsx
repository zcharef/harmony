import { Button, Select, SelectItem, Spinner, Switch, Tooltip } from '@heroui/react'
import { Hash, Lock, Plus, Trash2, Volume2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CreateChannelDialog,
  useChannels,
  useDeleteChannel,
  useUpdateChannel,
} from '@/features/channels'
import { useCryptoStore } from '@/features/crypto'
import { type MemberRole, ROLE_HIERARCHY } from '@/features/members'
import type { ChannelResponse } from '@/lib/api'
import { createMegolmSession } from '@/lib/api'
import { createOutboundSession } from '@/lib/crypto-megolm'
import { logger } from '@/lib/logger'
import { isTauri } from '@/lib/platform'
import { toast } from '@/lib/toast'

/** WHY: Static presets matching Discord's slow mode options. */
const SLOW_MODE_OPTIONS = [
  { value: '0', labelKey: 'slowModeOff' },
  { value: '5', labelKey: 'slowMode5s' },
  { value: '10', labelKey: 'slowMode10s' },
  { value: '15', labelKey: 'slowMode15s' },
  { value: '30', labelKey: 'slowMode30s' },
  { value: '60', labelKey: 'slowMode1m' },
  { value: '120', labelKey: 'slowMode2m' },
  { value: '300', labelKey: 'slowMode5m' },
  { value: '600', labelKey: 'slowMode10m' },
  { value: '1800', labelKey: 'slowMode30m' },
  { value: '3600', labelKey: 'slowMode1h' },
  { value: '21600', labelKey: 'slowMode6h' },
] as const

/**
 * WHY extracted: Encapsulates the multi-step Megolm session creation workflow
 * that runs after the API confirms encryption is enabled on the channel.
 * Keeps ChannelRow's event handler lean.
 */
async function createAndRegisterMegolmSession(channelId: string): Promise<void> {
  const session = await createOutboundSession(channelId)
  await createMegolmSession({
    path: { id: channelId },
    body: { sessionId: session.session_id },
    throwOnError: true,
  })
}

function ChannelRow({
  channel,
  serverId,
  canManage,
  isOwner,
  onDelete,
}: {
  channel: ChannelResponse
  serverId: string
  canManage: boolean
  /** WHY: Only the server owner can enable E2EE (one-way toggle). */
  isOwner: boolean
  onDelete: () => void
}) {
  const { t } = useTranslation('settings')
  const { t: tCrypto } = useTranslation('crypto')

  const [isEnabling, setIsEnabling] = useState(false)

  const updatePerms = useUpdateChannel(serverId, channel.id)
  const isDesktop = isTauri()
  const isInitialized = useCryptoStore((s) => s.isInitialized)

  function handlePrivateToggle(value: boolean) {
    updatePerms.mutate({ isPrivate: value })
  }

  function handleReadOnlyToggle(value: boolean) {
    updatePerms.mutate({ isReadOnly: value })
  }

  async function handleEncryptionToggle(value: boolean) {
    // WHY: One-way toggle — can only enable, never disable.
    if (!value) return
    if (channel.encrypted) return

    if (!window.confirm(tCrypto('enableEncryptionConfirm', { channelName: channel.name }))) {
      return
    }

    setIsEnabling(true)
    try {
      // Step 1: Enable encryption on the channel via API
      updatePerms.mutate(
        { encrypted: true },
        {
          onSuccess: async () => {
            try {
              // Step 2: Create outbound Megolm session + register with API
              await createAndRegisterMegolmSession(channel.id)
              toast.success(tCrypto('encryptionEnabledSuccess', { channelName: channel.name }))
            } catch (error) {
              logger.error('Failed to create Megolm session after enabling encryption', {
                channelId: channel.id,
                error: error instanceof Error ? error.message : String(error),
              })
              toast.error(tCrypto('encryptionEnableFailed'))
            } finally {
              setIsEnabling(false)
            }
          },
          // WHY no toast: hook-level onError already shows one via getApiErrorDetail.
          // Adding a second here would stack two toasts for one failure (ADR-028).
          onError: () => {
            setIsEnabling(false)
          },
        },
      )
    } catch (error) {
      logger.error('Unexpected error enabling encryption', {
        channelId: channel.id,
        error: error instanceof Error ? error.message : String(error),
      })
      setIsEnabling(false)
    }
  }

  /** WHY: E2EE toggle is only shown to owner, on desktop, with crypto initialized. */
  const canEnableEncryption = isOwner && isDesktop && isInitialized

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
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium text-foreground">{channel.name}</span>
          {channel.encrypted && (
            <Lock className="h-3 w-3 shrink-0 text-success" data-test="channel-encrypted-icon" />
          )}
        </div>
        {channel.topic !== undefined && channel.topic !== null && (
          <p className="truncate text-xs text-default-400">{channel.topic}</p>
        )}
      </div>
      {canManage && (
        <div className="flex items-center gap-4">
          <Tooltip content={t('slowModeTooltip')} placement="top" delay={300}>
            <div>
              <Select
                aria-label={t('slowMode')}
                size="sm"
                className="w-28"
                selectedKeys={new Set([String(channel.slowModeSeconds)])}
                onSelectionChange={(selection) => {
                  const first = [...selection][0]
                  if (first === undefined) return
                  updatePerms.mutate({ slowModeSeconds: Number(first) })
                }}
                data-test="channel-slowmode-select"
              >
                {SLOW_MODE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value}>{t(opt.labelKey)}</SelectItem>
                ))}
              </Select>
            </div>
          </Tooltip>
          {canEnableEncryption && (
            <Tooltip
              content={
                channel.encrypted ? tCrypto('encryptionPermanent') : tCrypto('enableEncryption')
              }
              placement="top"
              delay={300}
            >
              <div>
                <Switch
                  size="sm"
                  isSelected={channel.encrypted}
                  isDisabled={channel.encrypted || isEnabling}
                  onValueChange={handleEncryptionToggle}
                  aria-label={tCrypto('enableEncryption')}
                  data-test="channel-encryption-toggle"
                >
                  <span className="text-xs text-default-500">{tCrypto('encrypted')}</span>
                </Switch>
              </div>
            </Tooltip>
          )}
          {!canEnableEncryption && isOwner && !isDesktop && (
            <Tooltip content={tCrypto('encryptionDesktopOnly')} placement="top" delay={300}>
              <div>
                <Switch
                  size="sm"
                  isSelected={channel.encrypted}
                  isDisabled
                  aria-label={tCrypto('enableEncryption')}
                  data-test="channel-encryption-toggle-disabled"
                >
                  <span className="text-xs text-default-500">{tCrypto('encrypted')}</span>
                </Switch>
              </div>
            </Tooltip>
          )}
          <Switch
            size="sm"
            isSelected={channel.isPrivate}
            onValueChange={handlePrivateToggle}
            aria-label={t('privateChannel')}
            data-test="channel-private-toggle"
          >
            <span className="text-xs text-default-500">{t('private')}</span>
          </Switch>
          <Switch
            size="sm"
            isSelected={channel.isReadOnly}
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
      )}
    </div>
  )
}

interface ChannelsTabProps {
  serverId: string
  callerRole: MemberRole
  /** WHY: Needed to show E2EE toggle only for the server owner. */
  isOwner: boolean
}

export function ChannelsTab({ serverId, callerRole, isOwner }: ChannelsTabProps) {
  const { t } = useTranslation('settings')
  const { data: channels, isPending } = useChannels(serverId)
  const deleteChannel = useDeleteChannel(serverId)
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const canManage = ROLE_HIERARCHY[callerRole] >= ROLE_HIERARCHY.admin

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
        {canManage && (
          <Button
            color="primary"
            startContent={<Plus className="h-4 w-4" />}
            onPress={() => setIsCreateOpen(true)}
            data-test="settings-create-channel-button"
          >
            {t('channels:createChannel')}
          </Button>
        )}
      </div>

      <div data-test="settings-channel-list" className="space-y-1">
        {channels?.map((channel) => (
          <ChannelRow
            key={channel.id}
            channel={channel}
            serverId={serverId}
            canManage={canManage}
            isOwner={isOwner}
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
