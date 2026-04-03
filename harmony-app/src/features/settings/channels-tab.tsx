import { Button, Chip, Divider, Select, SelectItem, Spinner, Switch } from '@heroui/react'
import { ChevronDown, Clock, Hash, Lock, Plus, Trash2, Volume2 } from 'lucide-react'
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

/** WHY: Reusable row layout matching moderation-tab.tsx pattern — label + description left, control right. */
function SettingRow({
  label,
  description,
  children,
}: {
  label: string
  description: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="text-xs text-default-400">{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

function ChannelSettingsCard({
  channel,
  serverId,
  isOwner,
  onDelete,
}: {
  channel: ChannelResponse
  serverId: string
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
  const showSlowModeActive = channel.slowModeSeconds > 0

  return (
    <div
      className="rounded-lg border border-default-200 bg-default-50 p-4"
      data-test="channel-settings-card"
      data-channel-id={channel.id}
    >
      {/* Section 1: Slow Mode */}
      <div className="mb-1">
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-default-500" />
          <p className="text-sm font-medium text-foreground">{t('slowMode')}</p>
          {showSlowModeActive && (
            <Chip size="sm" variant="flat" color="primary">
              {t(
                SLOW_MODE_OPTIONS.find((o) => o.value === String(channel.slowModeSeconds))
                  ?.labelKey ?? 'slowModeOff',
              )}
            </Chip>
          )}
        </div>
        <p className="mb-3 mt-0.5 text-xs text-default-400">{t('slowModeTooltip')}</p>
        <Select
          aria-label={t('slowMode')}
          size="sm"
          className="max-w-xs"
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

      <Divider className="my-4" />

      {/* Section 2: Channel Permissions */}
      <div>
        <SettingRow label={t('privateChannelLabel')} description={t('privateChannelHelp')}>
          <Switch
            size="sm"
            isSelected={channel.isPrivate}
            onValueChange={handlePrivateToggle}
            aria-label={t('privateChannel')}
            data-test="channel-private-toggle"
          />
        </SettingRow>

        <SettingRow label={t('readOnlyChannelLabel')} description={t('readOnlyChannelHelp')}>
          <Switch
            size="sm"
            isSelected={channel.isReadOnly}
            onValueChange={handleReadOnlyToggle}
            aria-label={t('readOnlyChannel')}
            data-test="channel-readonly-toggle"
          />
        </SettingRow>

        {canEnableEncryption && (
          <SettingRow
            label={tCrypto('enableEncryption')}
            description={
              channel.encrypted
                ? tCrypto('encryptionPermanent')
                : tCrypto('enableEncryptionConfirm', { channelName: channel.name })
            }
          >
            <Switch
              size="sm"
              isSelected={channel.encrypted}
              isDisabled={channel.encrypted || isEnabling}
              onValueChange={handleEncryptionToggle}
              aria-label={tCrypto('enableEncryption')}
              data-test="channel-encryption-toggle"
            />
          </SettingRow>
        )}

        {!canEnableEncryption && isOwner && !isDesktop && (
          <SettingRow
            label={tCrypto('enableEncryption')}
            description={tCrypto('encryptionDesktopOnly')}
          >
            <Switch
              size="sm"
              isSelected={channel.encrypted}
              isDisabled
              aria-label={tCrypto('enableEncryption')}
              data-test="channel-encryption-toggle-disabled"
            />
          </SettingRow>
        )}
      </div>

      <Divider className="my-4" />

      {/* Section 3: Danger Zone */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-danger">{t('channels:deleteChannel')}</p>
          <p className="text-xs text-default-400">
            {t('channels:deleteConfirm', { channelName: channel.name })}
          </p>
        </div>
        <Button
          variant="flat"
          size="sm"
          color="danger"
          onPress={onDelete}
          aria-label={t('channels:deleteChannel')}
          data-test="channel-delete-button"
        >
          <Trash2 className="h-4 w-4" />
          {t('channels:deleteChannel')}
        </Button>
      </div>
    </div>
  )
}

function ChannelRow({
  channel,
  serverId,
  canManage,
  isOwner,
  isExpanded,
  onToggle,
  onDelete,
}: {
  channel: ChannelResponse
  serverId: string
  canManage: boolean
  /** WHY: Only the server owner can enable E2EE (one-way toggle). */
  isOwner: boolean
  isExpanded: boolean
  onToggle: () => void
  onDelete: () => void
}) {
  return (
    <div data-test="settings-channel-row" data-channel-id={channel.id}>
      <button
        type="button"
        className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-default-50"
        onClick={canManage ? onToggle : undefined}
        aria-expanded={canManage ? isExpanded : undefined}
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
          <ChevronDown
            className={`h-4 w-4 shrink-0 text-default-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
          />
        )}
      </button>

      {canManage && isExpanded && (
        <div className="px-3 pb-3 pt-1">
          <ChannelSettingsCard
            channel={channel}
            serverId={serverId}
            isOwner={isOwner}
            onDelete={onDelete}
          />
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
  const [expandedChannelId, setExpandedChannelId] = useState<string | null>(null)
  const canManage = ROLE_HIERARCHY[callerRole] >= ROLE_HIERARCHY.admin

  function handleDeleteChannel(channel: ChannelResponse) {
    if (window.confirm(t('channels:deleteConfirm', { channelName: channel.name }))) {
      deleteChannel.mutate(channel.id)
    }
  }

  function handleToggleExpand(channelId: string) {
    setExpandedChannelId((prev) => (prev === channelId ? null : channelId))
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
            isExpanded={expandedChannelId === channel.id}
            onToggle={() => handleToggleExpand(channel.id)}
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
