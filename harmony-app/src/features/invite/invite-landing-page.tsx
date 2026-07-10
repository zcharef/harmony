/**
 * Invite landing page — /invite/:code
 *
 * The referral loop's activation surface (growth-plan §7): an invitee gets
 * full server context BEFORE having an account (icon, name, member count,
 * "Maya invited you"), and creates the account only AFTER clicking accept.
 *
 * Flow:
 *   unauthenticated → preview card → "Accept invite" records intent and
 *   shows login/signup (URL stays /invite/:code) → after auth this page
 *   remounts authenticated → recorded intent auto-joins → onDone(serverId).
 */

import { Avatar, Button, Card, CardBody, CardHeader, Chip, Spinner } from '@heroui/react'
import { Users } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LoginPage, useAuthStore } from '@/features/auth'
import type { InvitePreviewResponse } from '@/lib/api'
import { getApiErrorDetail } from '@/lib/api-error'
import { useAcceptInvite } from './hooks/use-accept-invite'
import { isInviteNotFound, useInvitePreview } from './hooks/use-invite-preview'
import { clearInviteIntent, hasInviteIntent, recordInviteIntent } from './lib/invite-intent'

interface InviteLandingPageProps {
  code: string
  /** Called when the flow is finished: joined server id, or null to just enter the app. */
  onDone: (serverId: string | null) => void
}

export function InviteLandingPage({ code, onDone }: InviteLandingPageProps) {
  const { t } = useTranslation('invite')
  const session = useAuthStore((s) => s.session)
  const [showAuth, setShowAuth] = useState(false)
  const preview = useInvitePreview(code)
  const acceptInvite = useAcceptInvite()

  const isAuthed = session !== null
  const serverId = preview.data?.serverId

  // WHY: "account creation AFTER intent" — a pre-auth accept click was
  // recorded in sessionStorage; once the user is back here authenticated,
  // finish the join without demanding a second click.
  useEffect(() => {
    if (!isAuthed || serverId === undefined || !hasInviteIntent(code)) return
    if (!acceptInvite.isIdle) return

    clearInviteIntent(code)
    acceptInvite.mutate(
      { serverId, code },
      {
        onSuccess: (joinedServerId) => onDone(joinedServerId),
      },
    )
  }, [isAuthed, serverId, code, acceptInvite, onDone])

  function handleAccept() {
    if (serverId === undefined) return

    if (!isAuthed) {
      recordInviteIntent(code)
      setShowAuth(true)
      return
    }

    acceptInvite.mutate(
      { serverId, code },
      {
        onSuccess: (joinedServerId) => onDone(joinedServerId),
      },
    )
  }

  // WHY: the URL stays /invite/:code while LoginPage renders, so once the
  // session appears App re-renders this page in its authenticated state.
  if (!isAuthed && showAuth) {
    return <LoginPage />
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md" data-test="invite-landing-page">
        <CardHeader className="flex flex-col items-center gap-2 pb-0 pt-6">
          <img src="/brand/logo_vertical_dark.png" alt="Harmony" className="h-24 w-auto" />
          <Chip color="secondary" size="sm" variant="dot">
            {t('alphaLabel', { ns: 'common' })}
          </Chip>
        </CardHeader>

        <CardBody className="gap-4 px-6 pb-6">
          {preview.isPending && (
            <div className="flex flex-col items-center py-6">
              <Spinner size="lg" color="primary" data-test="invite-loading" />
            </div>
          )}

          {preview.isError && isInviteNotFound(preview.error) && (
            <InviteInvalid onContinue={() => onDone(null)} />
          )}

          {preview.isError && !isInviteNotFound(preview.error) && (
            <InviteLoadError onRetry={() => void preview.refetch()} />
          )}

          {preview.isSuccess && (
            <InvitePreviewCard
              preview={preview.data}
              isAuthed={isAuthed}
              isJoining={acceptInvite.isPending}
              joinError={
                acceptInvite.isError ? getApiErrorDetail(acceptInvite.error, t('joinFailed')) : null
              }
              onAccept={handleAccept}
            />
          )}
        </CardBody>
      </Card>
    </div>
  )
}

/** Dead invite (expired, exhausted, or never existed — the API doesn't say which). */
function InviteInvalid({ onContinue }: { onContinue: () => void }) {
  const { t } = useTranslation('invite')
  return (
    <div className="flex flex-col items-center gap-3" data-test="invite-invalid">
      <p className="text-center text-lg font-semibold text-foreground">{t('invalidTitle')}</p>
      <p className="text-center text-sm text-default-500">{t('invalidSubtitle')}</p>
      <Button
        variant="flat"
        className="w-full"
        onPress={onContinue}
        data-test="invite-continue-button"
      >
        {t('continueToApp')}
      </Button>
    </div>
  )
}

/** Network/server failure loading the preview — retryable, per ADR-028. */
function InviteLoadError({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation('invite')
  return (
    <div className="flex flex-col items-center gap-3" data-test="invite-load-error">
      <p className="text-center text-sm text-danger">{t('loadFailed')}</p>
      <Button variant="flat" className="w-full" onPress={onRetry} data-test="invite-retry-button">
        {t('retryNow', { ns: 'common' })}
      </Button>
    </div>
  )
}

function InvitePreviewCard({
  preview,
  isAuthed,
  isJoining,
  joinError,
  onAccept,
}: {
  preview: InvitePreviewResponse
  isAuthed: boolean
  isJoining: boolean
  joinError: string | null
  onAccept: () => void
}) {
  const { t } = useTranslation('invite')

  return (
    <div className="flex flex-col items-center gap-3 py-2">
      {preview.inviterDisplayName !== null && preview.inviterDisplayName !== undefined && (
        <div className="flex items-center gap-2" data-test="invite-inviter">
          <Avatar
            size="sm"
            name={preview.inviterDisplayName}
            src={preview.inviterAvatarUrl ?? undefined}
          />
          <span className="text-sm text-default-500">
            {t('invitedYou', { name: preview.inviterDisplayName })}
          </span>
        </div>
      )}

      {preview.serverIconUrl !== null && preview.serverIconUrl !== undefined ? (
        <img
          src={preview.serverIconUrl}
          alt={preview.serverName}
          className="h-16 w-16 rounded-2xl object-cover"
          data-test="invite-server-icon"
        />
      ) : (
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
      )}

      <span className="text-lg font-semibold text-foreground" data-test="invite-server-name">
        {preview.serverName}
      </span>

      <div className="flex items-center gap-1.5 text-sm text-default-500">
        <Users className="h-4 w-4" />
        <span data-test="invite-member-count">
          {t('memberCount', { ns: 'servers', count: preview.memberCount })}
        </span>
      </div>

      {joinError !== null && (
        <p className="text-center text-sm text-danger" data-test="invite-join-error">
          {joinError}
        </p>
      )}

      <Button
        color="primary"
        className="w-full"
        onPress={onAccept}
        isLoading={isJoining}
        data-test="invite-accept-button"
      >
        {t('acceptInvite')}
      </Button>

      {!isAuthed && <p className="text-center text-xs text-default-400">{t('signInToAccept')}</p>}
    </div>
  )
}
