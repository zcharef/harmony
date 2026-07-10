import type { PopoverProps } from '@heroui/react'
import { Avatar, Button, Popover, PopoverContent, PopoverTrigger, Spinner } from '@heroui/react'
import { type QueryClient, useQueryClient } from '@tanstack/react-query'
import { Crown, type LucideIcon, Shield, Star, UserX } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ErrorState } from '@/components/shared/error-state'
import { useAuthStore } from '@/features/auth'
import { StatusIndicator, useUserStatus } from '@/features/presence'
import { useSettingsUiStore } from '@/features/settings'
import type { MemberListResponse, MemberResponse, UserStatus } from '@/lib/api'
import { isProblemDetails } from '@/lib/api-error'
import { resolveDisplayName } from '@/lib/display-name'
import { queryKeys } from '@/lib/query-keys'
import { useProfile } from '../hooks/use-profile'
import { ProfileBio } from './profile-bio'

// WHY a local role badge (not the members feature's RoleBadge): importing from
// `@/features/members` would form a cycle — member-list.tsx (re-exported by
// members/index.ts) imports ProfilePopover. The card only needs to render one
// of four fixed role icons from the member context's `role` string, so this
// stays a tiny, self-contained mapping rather than a cross-feature dependency.
// WHY Record<string, …>: lets us index by the raw member `role` string without
// an `as` assertion (ADR-035) — an unknown role simply yields undefined.
const ROLE_ICON: Record<string, LucideIcon> = { owner: Crown, admin: Shield, moderator: Star }

function CardRoleBadge({ role }: { role: string }) {
  const Icon = ROLE_ICON[role]
  if (Icon === undefined) return null
  return <Icon className="h-3.5 w-3.5 shrink-0 text-default-500" aria-label={role} />
}

interface ProfilePopoverProps {
  /** The subject whose profile the card shows. */
  userId: string
  /** Server context for the tier-1 member cache (nickname/role/joinedAt). `null` in DM/voice. */
  serverId: string | null
  /** The trigger element (avatar or name). Becomes the popover's pressable child. */
  children: ReactNode
  placement?: PopoverProps['placement']
}

/**
 * Discord-style profile hover card, opened on CLICK/PRESS of an identity
 * trigger (avatar or name) — not hover, for a11y + virtualized-list stability
 * (ticket §1). Reuses the `EmojiPickerPopover` shape: controlled open state, the
 * trigger wrapped by `PopoverTrigger`, lazy content.
 *
 * Two data tiers merge at render: tier-1 = the cached `MemberResponse`
 * (nickname/role/server joinedAt, zero fetch); tier-2 = `GET /v1/profiles/{id}`
 * (bio/banner/customStatus/account createdAt), fetched only while open and kept
 * live by the `profile.updated` SSE patch on the same cache key.
 */
export function ProfilePopover({
  userId,
  serverId,
  children,
  placement = 'right-start',
}: ProfilePopoverProps) {
  const [isOpen, setIsOpen] = useState(false)

  return (
    <Popover isOpen={isOpen} onOpenChange={setIsOpen} placement={placement}>
      <PopoverTrigger>{children}</PopoverTrigger>
      <PopoverContent className="w-72 p-0">
        {isOpen ? (
          <ProfileCard userId={userId} serverId={serverId} onClose={() => setIsOpen(false)} />
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

/** Read the tier-1 member context from cache (read-only — never mounts a query). */
function readMemberContext(
  queryClient: QueryClient,
  serverId: string | null,
  userId: string,
): MemberResponse | null {
  if (serverId === null) return null
  const data = queryClient.getQueryData<MemberListResponse>(queryKeys.servers.members(serverId))
  return data?.items.find((m) => m.userId === userId) ?? null
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the card is a small state machine (deleted / no-context-loading / no-context-error / merged render) — the branches are the spec's UX states (ticket §1) and read more clearly inline than scattered across extra components
function ProfileCard({
  userId,
  serverId,
  onClose,
}: {
  userId: string
  serverId: string | null
  onClose: () => void
}) {
  const { t } = useTranslation('profiles')
  const queryClient = useQueryClient()
  const currentUserId = useAuthStore((s) => s.user?.id ?? null)
  const openUserSettings = useSettingsUiStore((s) => s.openUserSettings)

  const memberContext = readMemberContext(queryClient, serverId, userId)
  // Card is mounted only while open, so the query fires exactly once per open.
  const profileQuery = useProfile(userId)
  const profile = profileQuery.data
  const liveStatus = useUserStatus(userId)

  // Deleted account (404): a minimal, muted card (ticket §1).
  if (isProblemDetails(profileQuery.error) && profileQuery.error.status === 404) {
    return <DeletedCard label={t('deletedUserName')} handle={t('deletedUser')} />
  }

  // No tier-1 context (voice cross-server, message from a departed user) and the
  // account fetch has not landed → whole card is loading, or hard-errored.
  if (memberContext === null && profileQuery.isPending) {
    return <CardSpinner />
  }
  if (memberContext === null && profileQuery.isError) {
    return (
      <ErrorState
        icon={<UserX className="h-8 w-8" />}
        message={t('loadFailedFull')}
        onRetry={() => profileQuery.refetch()}
        retryLabel={t('retry')}
        isRetrying={profileQuery.isFetching}
      />
    )
  }

  const isSelf = currentUserId !== null && currentUserId === userId
  const label = resolveDisplayName({
    nickname: memberContext?.nickname,
    displayName: profile?.displayName ?? memberContext?.displayName,
    username: profile?.username ?? memberContext?.username ?? '',
  })
  const username = profile?.username ?? memberContext?.username ?? ''
  const status: UserStatus = liveStatus ?? profile?.status ?? 'offline'

  return (
    <section
      role="dialog"
      aria-label={t('cardLabel', { name: label })}
      className="flex flex-col"
      data-test="profile-card"
    >
      <BannerStrip
        bannerUrl={profile?.bannerUrl ?? null}
        isLoading={profileQuery.isPending}
        alt={t('bannerAlt')}
      />
      <div className="flex flex-col gap-2 px-3 pb-3">
        <div className="-mt-8 flex items-end justify-between">
          <Avatar
            name={label}
            src={profile?.avatarUrl ?? memberContext?.avatarUrl ?? undefined}
            size="lg"
            showFallback
            color="primary"
            className="ring-4 ring-content1"
            data-test="profile-card-avatar"
          />
          {isSelf && (
            <Button
              size="sm"
              variant="flat"
              onPress={() => {
                openUserSettings('profile')
                onClose()
              }}
              data-test="profile-card-edit"
            >
              {t('editProfile')}
            </Button>
          )}
        </div>

        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-1.5">
            <StatusIndicator status={status} size="sm" />
            <span className="truncate font-semibold text-foreground" data-test="profile-card-name">
              {label}
            </span>
            {memberContext !== null && <CardRoleBadge role={memberContext.role} />}
          </div>
          <span className="truncate text-sm text-default-500" data-test="profile-card-username">
            @{username}
          </span>
        </div>

        {profile?.customStatus !== undefined && profile.customStatus !== null && (
          <p className="text-sm text-default-600" data-test="profile-card-status">
            {profile.customStatus}
          </p>
        )}

        <MemberSince
          joinedAt={memberContext?.joinedAt ?? null}
          accountCreatedAt={profile?.createdAt ?? null}
        />

        <AccountTier
          isLoading={profileQuery.isPending}
          isError={profileQuery.isError}
          bio={profile?.bio ?? null}
          onRetry={() => profileQuery.refetch()}
        />
      </div>
    </section>
  )
}

/** Banner: a wide strip; empty → flat band so the avatar still overlaps a surface. */
function BannerStrip({
  bannerUrl,
  isLoading,
  alt,
}: {
  bannerUrl: string | null
  isLoading: boolean
  alt: string
}) {
  if (bannerUrl !== null) {
    return (
      <img
        src={bannerUrl}
        alt={alt}
        className="aspect-[16/6] w-full rounded-t-lg object-cover"
        data-test="profile-card-banner"
      />
    )
  }
  return (
    <div
      className="flex aspect-[16/6] w-full items-center justify-center rounded-t-lg bg-default-200"
      data-test="profile-card-banner-empty"
    >
      {isLoading && <Spinner size="sm" />}
    </div>
  )
}

/** "Member since" (server join) + account-created dates, each shown when known. */
function MemberSince({
  joinedAt,
  accountCreatedAt,
}: {
  joinedAt: string | null
  accountCreatedAt: string | null
}) {
  const { t } = useTranslation('profiles')
  if (joinedAt === null && accountCreatedAt === null) return null
  return (
    <div className="flex flex-col gap-0.5 text-xs text-default-400" data-test="profile-card-since">
      {joinedAt !== null && <span>{t('memberSince', { date: formatDate(joinedAt) })}</span>}
      {accountCreatedAt !== null && (
        <span>{t('accountCreated', { date: formatDate(accountCreatedAt) })}</span>
      )}
    </div>
  )
}

/**
 * The account (tier-2) region: a spinner while the fetch is in flight, a retry
 * affordance on a non-404 failure (NEVER a toast — a passive read the user did
 * not explicitly request, ADR-045), or the bio (omitted entirely when empty).
 */
function AccountTier({
  isLoading,
  isError,
  bio,
  onRetry,
}: {
  isLoading: boolean
  isError: boolean
  bio: string | null
  onRetry: () => void
}) {
  const { t } = useTranslation('profiles')

  if (isLoading) {
    return (
      <div className="flex justify-center py-1" data-test="profile-card-bio-loading">
        <Spinner size="sm" />
      </div>
    )
  }
  if (isError) {
    return (
      <button
        type="button"
        onClick={onRetry}
        className="text-left text-xs text-default-400 underline"
        data-test="profile-card-bio-error"
      >
        {t('loadFailed')}
      </button>
    )
  }
  if (bio === null || bio.trim() === '') return null
  return <ProfileBio bio={bio} />
}

function DeletedCard({ label, handle }: { label: string; handle: string }) {
  return (
    <section className="flex items-center gap-2 p-3 opacity-70" data-test="profile-card-deleted">
      <Avatar name={label} size="md" showFallback />
      <span className="text-sm text-default-500">{handle}</span>
    </section>
  )
}

function CardSpinner() {
  return (
    <div className="flex justify-center p-6" data-test="profile-card-loading">
      <Spinner size="sm" />
    </div>
  )
}

/** Localized short date (e.g. "Jul 10, 2026") from an ISO timestamp. */
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}
