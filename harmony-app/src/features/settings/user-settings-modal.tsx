import {
  Avatar,
  Button,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalHeader,
  Spinner,
  Tab,
  Tabs,
} from '@heroui/react'
import { zodResolver } from '@hookform/resolvers/zod'
import type { TFunction } from 'i18next'
import { type ChangeEvent, useRef } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'
import {
  AvatarUploadError,
  type AvatarUploadErrorCode,
  useCurrentProfile,
  useUpdateProfile,
  useUploadAvatar,
} from '@/features/auth'
import { NotificationSettingsTab } from '@/features/notifications'
import type { ProfileResponse } from '@/lib/api'
import { getApiErrorDetail } from '@/lib/api-error'
import { resolveDisplayName } from '@/lib/display-name'
import { type UserSettingsTab, useSettingsUiStore } from './stores/settings-ui-store'

const DISPLAY_NAME_MAX = 32
const CUSTOM_STATUS_MAX = 128

function profileFormSchema(t: TFunction<'settings'>) {
  return z.object({
    // WHY max-only: blank is valid — it clears the display name (renders as
    // username per the identity render chain). Non-blank must be 1-32 chars.
    displayName: z.string().trim().max(DISPLAY_NAME_MAX, t('displayNameMaxLength')),
    customStatus: z.string().trim().max(CUSTOM_STATUS_MAX, t('customStatusMaxLength')),
  })
}

type ProfileForm = z.infer<ReturnType<typeof profileFormSchema>>

const AVATAR_ERROR_KEYS: Record<AvatarUploadErrorCode, string> = {
  invalidType: 'avatarErrorInvalidType',
  tooLarge: 'avatarErrorTooLarge',
  gifTooLarge: 'avatarErrorGifTooLarge',
  processingFailed: 'avatarErrorProcessingFailed',
  uploadFailed: 'avatarErrorUploadFailed',
}

/** Maps an avatar pipeline failure to a user-actionable inline message. */
function resolveAvatarErrorMessage(error: unknown, t: TFunction<'settings'>): string {
  if (error instanceof AvatarUploadError) {
    return t(AVATAR_ERROR_KEYS[error.code])
  }
  return getApiErrorDetail(error, t('avatarErrorUploadFailed'))
}

/**
 * Global user settings modal (HeroUI Tabs): Profile (display name, custom
 * status, avatar) + Notifications (delivery + sound switches).
 * Opened via the gear button in both sidebars; mounted once in MainLayout.
 */
export function UserSettingsModal() {
  const { t } = useTranslation('settings')
  const isOpen = useSettingsUiStore((s) => s.showUserSettings)
  const selectedTab = useSettingsUiStore((s) => s.userSettingsTab)
  const setUserSettingsTab = useSettingsUiStore((s) => s.setUserSettingsTab)
  const closeUserSettings = useSettingsUiStore((s) => s.closeUserSettings)

  // WHY unmount when closed: guarantees the profile form re-reads fresh
  // defaults from the profile cache on every open (load-then-render,
  // CLAUDE.md 4.4 — no useEffect reset).
  if (isOpen === false) return null

  return (
    <Modal isOpen onClose={closeUserSettings} size="lg" data-test="user-settings-modal">
      <ModalContent>
        <ModalHeader>{t('userSettingsTitle')}</ModalHeader>
        <ModalBody className="pb-6">
          <Tabs
            selectedKey={selectedTab}
            onSelectionChange={(key) => {
              const tab: UserSettingsTab | null =
                key === 'profile' || key === 'notifications' ? key : null
              if (tab !== null) setUserSettingsTab(tab)
            }}
            aria-label={t('userSettingsTitle')}
          >
            <Tab key="profile" title={t('tabProfile')} data-test="user-settings-tab-profile">
              <ProfileTab onClose={closeUserSettings} />
            </Tab>
            <Tab
              key="notifications"
              title={t('tabNotifications')}
              data-test="user-settings-tab-notifications"
            >
              <NotificationSettingsTab />
            </Tab>
          </Tabs>
        </ModalBody>
      </ModalContent>
    </Modal>
  )
}

function ProfileTab({ onClose }: { onClose: () => void }) {
  const { data: profile, isPending } = useCurrentProfile()

  if (isPending || profile === undefined) {
    return (
      <div className="flex items-center justify-center py-10">
        <Spinner size="sm" />
      </div>
    )
  }

  return <ProfileSettingsForm profile={profile} onClose={onClose} />
}

function ProfileSettingsForm({
  profile,
  onClose,
}: {
  profile: ProfileResponse
  onClose: () => void
}) {
  const { t } = useTranslation('settings')
  const saveProfile = useUpdateProfile()
  // WHY a second instance: Remove is an independent action with its own
  // pending/error state — sharing the Save mutation would cross-wire spinners
  // and inline error attribution.
  const removeAvatar = useUpdateProfile()
  const uploadAvatar = useUploadAvatar()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const schema = profileFormSchema(t)
  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<ProfileForm>({
    resolver: zodResolver(schema),
    mode: 'onChange',
    defaultValues: {
      displayName: profile.displayName ?? '',
      customStatus: profile.customStatus ?? '',
    },
  })

  const displayNameLength = watch('displayName').length
  const customStatusLength = watch('customStatus').length
  const avatarUrl = profile.avatarUrl ?? null

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    // WHY reset: selecting the same file twice must re-trigger onChange.
    event.target.value = ''
    if (file === undefined) return
    uploadAvatar.mutate(file)
  }

  function handleRemoveAvatar() {
    // WHY explicit null: the API's patch contract — null clears the field.
    removeAvatar.mutate({ avatarUrl: null })
  }

  function onSubmit(values: ProfileForm) {
    saveProfile.mutate(
      {
        displayName: values.displayName === '' ? null : values.displayName,
        customStatus: values.customStatus === '' ? null : values.customStatus,
      },
      { onSuccess: () => onClose() },
    )
  }

  const avatarErrorMessage = uploadAvatar.isError
    ? resolveAvatarErrorMessage(uploadAvatar.error, t)
    : removeAvatar.isError
      ? getApiErrorDetail(removeAvatar.error, t('avatarRemoveFailed'))
      : null

  const saveErrorMessage = saveProfile.isError
    ? getApiErrorDetail(saveProfile.error, t('profileUpdateFailed'))
    : null

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
      <div className="flex items-center gap-4">
        <Avatar
          src={avatarUrl ?? undefined}
          name={resolveDisplayName({
            displayName: profile.displayName,
            username: profile.username,
          })}
          size="lg"
          color="primary"
          showFallback
          data-test="profile-avatar-preview"
        />
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="flat"
              onPress={() => fileInputRef.current?.click()}
              isLoading={uploadAvatar.isPending}
              data-test="profile-avatar-upload-button"
            >
              {t('uploadAvatar')}
            </Button>
            {avatarUrl !== null && (
              <Button
                size="sm"
                variant="light"
                color="danger"
                onPress={handleRemoveAvatar}
                isLoading={removeAvatar.isPending}
                data-test="profile-avatar-remove-button"
              >
                {t('removeAvatar')}
              </Button>
            )}
          </div>
          <p className="text-xs text-default-400">{t('avatarHelp')}</p>
        </div>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        onChange={handleFileChange}
        aria-label={t('uploadAvatar')}
        data-test="profile-avatar-file-input"
      />
      {avatarErrorMessage !== null && (
        <p className="text-xs text-danger" data-test="profile-avatar-error">
          {avatarErrorMessage}
        </p>
      )}

      <Input
        label={t('displayNameLabel')}
        placeholder={t('displayNamePlaceholder')}
        description={t('displayNameHelp')}
        endContent={
          <span className="text-xs text-default-400">
            {displayNameLength}/{DISPLAY_NAME_MAX}
          </span>
        }
        isInvalid={errors.displayName !== undefined}
        errorMessage={errors.displayName?.message}
        data-test="profile-display-name-input"
        {...register('displayName')}
      />
      <Input
        label={t('customStatusLabel')}
        placeholder={t('customStatusPlaceholder')}
        endContent={
          <span className="text-xs text-default-400">
            {customStatusLength}/{CUSTOM_STATUS_MAX}
          </span>
        }
        isInvalid={errors.customStatus !== undefined}
        errorMessage={errors.customStatus?.message}
        data-test="profile-custom-status-input"
        {...register('customStatus')}
      />
      {saveErrorMessage !== null && (
        <p className="text-xs text-danger" data-test="profile-settings-error">
          {saveErrorMessage}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="light" onPress={onClose} data-test="profile-settings-cancel-button">
          {t('common:cancel')}
        </Button>
        <Button
          type="submit"
          color="primary"
          isLoading={saveProfile.isPending}
          data-test="profile-settings-save-button"
        >
          {t('common:save')}
        </Button>
      </div>
    </form>
  )
}
