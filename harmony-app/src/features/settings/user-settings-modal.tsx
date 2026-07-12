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
  Textarea,
} from '@heroui/react'
import { zodResolver } from '@hookform/resolvers/zod'
import type { TFunction } from 'i18next'
import { Check, Copy } from 'lucide-react'
import { type ChangeEvent, useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'
import { AdminTab } from '@/features/admin'
import {
  AvatarUploadError,
  type AvatarUploadErrorCode,
  useCurrentProfile,
  useUpdateProfile,
  useUploadAvatar,
  useUploadBanner,
} from '@/features/auth'
import { NotificationSettingsTab } from '@/features/notifications'
import type { ProfileResponse } from '@/lib/api'
import { getApiErrorDetail } from '@/lib/api-error'
import { resolveDisplayName } from '@/lib/display-name'
import { isTauri } from '@/lib/platform'
import { DesktopSettingsTab } from './desktop-settings-tab'
import { type UserSettingsTab, useSettingsUiStore } from './stores/settings-ui-store'

const DISPLAY_NAME_MAX = 32
const CUSTOM_STATUS_MAX = 128
const BIO_MAX = 190

function profileFormSchema(t: TFunction<'settings'>) {
  return z.object({
    // WHY max-only: blank is valid — it clears the display name (renders as
    // username per the identity render chain). Non-blank must be 1-32 chars.
    displayName: z.string().trim().max(DISPLAY_NAME_MAX, t('displayNameMaxLength')),
    customStatus: z.string().trim().max(CUSTOM_STATUS_MAX, t('customStatusMaxLength')),
    // WHY max-only: blank is valid — it clears the bio.
    bio: z.string().trim().max(BIO_MAX, t('bioMaxLength')),
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

const BANNER_ERROR_KEYS: Record<AvatarUploadErrorCode, string> = {
  invalidType: 'bannerErrorInvalidType',
  tooLarge: 'bannerErrorTooLarge',
  gifTooLarge: 'bannerErrorTooLarge',
  processingFailed: 'bannerErrorProcessingFailed',
  uploadFailed: 'bannerErrorUploadFailed',
}

/** Maps an avatar pipeline failure to a user-actionable inline message. */
function resolveAvatarErrorMessage(error: unknown, t: TFunction<'settings'>): string {
  if (error instanceof AvatarUploadError) {
    return t(AVATAR_ERROR_KEYS[error.code])
  }
  return getApiErrorDetail(error, t('avatarErrorUploadFailed'))
}

/** Maps a banner pipeline failure to a user-actionable inline message. */
function resolveBannerErrorMessage(error: unknown, t: TFunction<'settings'>): string {
  if (error instanceof AvatarUploadError) {
    return t(BANNER_ERROR_KEYS[error.code])
  }
  return getApiErrorDetail(error, t('bannerErrorUploadFailed'))
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
  // WHY: the Admin tab is revealed ONLY to the platform founder. The flag comes
  // from GET /v1/profiles/me (`isPlatformAdmin`); the backend is the real gate,
  // this is a defense-in-depth UI reveal.
  const { data: profile } = useCurrentProfile()
  const isPlatformAdmin = profile?.isPlatformAdmin === true

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
                key === 'profile' || key === 'notifications' || key === 'desktop' || key === 'admin'
                  ? key
                  : null
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
            {/* WHY isTauri gate: tray/autostart are desktop-shell behaviors —
                the web app has nothing to configure here. */}
            {isTauri() && (
              <Tab key="desktop" title={t('tabDesktop')} data-test="user-settings-tab-desktop">
                <DesktopSettingsTab />
              </Tab>
            )}
            {/* Founder-only: revealed by the me.isPlatformAdmin flag. */}
            {isPlatformAdmin && (
              <Tab key="admin" title={t('tabAdmin')} data-test="user-settings-tab-admin">
                <AdminTab />
              </Tab>
            )}
          </Tabs>
        </ModalBody>
      </ModalContent>
    </Modal>
  )
}

/**
 * Read-only @username with copy-to-clipboard. Usernames are immutable for now,
 * so this renders subdued (no form registration) with helper text saying so.
 * Copy confirmation follows the invite-code pattern: the icon swaps to a check
 * for 2s (create-invite-dialog.tsx).
 */
function UsernameField({ username }: { username: string }) {
  const { t } = useTranslation('settings')
  const [copied, setCopied] = useState(false)

  function handleCopy() {
    // WHY copy with the @: the pasted handle is directly usable as a mention.
    navigator.clipboard.writeText(`@${username}`)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Input
      label={t('usernameLabel')}
      value={`@${username}`}
      isReadOnly
      description={t('usernameHelp')}
      classNames={{ input: 'text-default-500' }}
      endContent={
        <Button
          isIconOnly
          size="sm"
          variant="light"
          onPress={handleCopy}
          aria-label={copied ? t('usernameCopied') : t('copyUsername')}
          data-test="profile-username-copy-button"
        >
          {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
        </Button>
      }
      data-test="profile-username-input"
    />
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

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the profile form owns five related controls (banner + avatar upload/remove, display name, custom status, bio) with their own pending/error state — splitting further would scatter tightly-coupled form logic
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
  const removeBanner = useUpdateProfile()
  const uploadAvatar = useUploadAvatar()
  const uploadBanner = useUploadBanner()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const bannerInputRef = useRef<HTMLInputElement>(null)

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
      bio: profile.bio ?? '',
    },
  })

  const displayNameLength = watch('displayName').length
  const customStatusLength = watch('customStatus').length
  const bioLength = watch('bio').length
  const avatarUrl = profile.avatarUrl ?? null
  const bannerUrl = profile.bannerUrl ?? null

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    // WHY reset: selecting the same file twice must re-trigger onChange.
    event.target.value = ''
    if (file === undefined) return
    uploadAvatar.mutate(file)
  }

  function handleBannerChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file === undefined) return
    uploadBanner.mutate(file)
  }

  function handleRemoveAvatar() {
    // WHY explicit null: the API's patch contract — null clears the field.
    removeAvatar.mutate({ avatarUrl: null })
  }

  function handleRemoveBanner() {
    removeBanner.mutate({ bannerUrl: null })
  }

  function onSubmit(values: ProfileForm) {
    saveProfile.mutate(
      {
        displayName: values.displayName === '' ? null : values.displayName,
        customStatus: values.customStatus === '' ? null : values.customStatus,
        bio: values.bio === '' ? null : values.bio,
      },
      { onSuccess: () => onClose() },
    )
  }

  const avatarErrorMessage = uploadAvatar.isError
    ? resolveAvatarErrorMessage(uploadAvatar.error, t)
    : removeAvatar.isError
      ? getApiErrorDetail(removeAvatar.error, t('avatarRemoveFailed'))
      : null

  const bannerErrorMessage = uploadBanner.isError
    ? resolveBannerErrorMessage(uploadBanner.error, t)
    : removeBanner.isError
      ? getApiErrorDetail(removeBanner.error, t('bannerRemoveFailed'))
      : null

  const saveErrorMessage = saveProfile.isError
    ? getApiErrorDetail(saveProfile.error, t('profileUpdateFailed'))
    : null

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
      {/* Banner preview + controls — empty renders a flat band (matches the
          profile card's empty banner). */}
      <div className="flex flex-col gap-2">
        {bannerUrl !== null ? (
          <img
            src={bannerUrl}
            alt=""
            className="aspect-[16/6] w-full rounded-lg object-cover"
            data-test="profile-banner-preview"
          />
        ) : (
          <div
            className="aspect-[16/6] w-full rounded-lg bg-default-200"
            data-test="profile-banner-empty"
          />
        )}
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="flat"
            onPress={() => bannerInputRef.current?.click()}
            isLoading={uploadBanner.isPending}
            data-test="profile-banner-upload-button"
          >
            {t('uploadBanner')}
          </Button>
          {bannerUrl !== null && (
            <Button
              size="sm"
              variant="light"
              color="danger"
              onPress={handleRemoveBanner}
              isLoading={removeBanner.isPending}
              data-test="profile-banner-remove-button"
            >
              {t('removeBanner')}
            </Button>
          )}
          <p className="text-xs text-default-400">{t('bannerHelp')}</p>
        </div>
        <input
          ref={bannerInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="hidden"
          onChange={handleBannerChange}
          aria-label={t('uploadBanner')}
          data-test="profile-banner-file-input"
        />
        {bannerErrorMessage !== null && (
          <p className="text-xs text-danger" data-test="profile-banner-error">
            {bannerErrorMessage}
          </p>
        )}
      </div>

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

      <UsernameField username={profile.username} />
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
      <Textarea
        label={t('bioLabel')}
        placeholder={t('bioPlaceholder')}
        description={t('bioHelp')}
        minRows={2}
        maxRows={4}
        endContent={
          <span className="text-xs text-default-400">
            {bioLength}/{BIO_MAX}
          </span>
        }
        isInvalid={errors.bio !== undefined}
        errorMessage={errors.bio?.message}
        data-test="profile-bio-input"
        {...register('bio')}
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
