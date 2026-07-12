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
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LoginPage, useAuthStore } from '@/features/auth'
import { useServers } from '@/features/server-nav'
import type { InvitePreviewResponse } from '@/lib/api'
import { getApiErrorDetail } from '@/lib/api-error'
import { isPlanGateError } from '@/lib/plan-gate'
import { isTauri } from '@/lib/platform'
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
  // WHY destructured: mutate is referentially stable in TanStack Query v5;
  // depending on the whole mutation object would re-run the effect on every
  // state transition of the mutation.
  const { mutate: acceptMutate, isIdle: acceptIsIdle } = acceptInvite

  // WHY: "account creation AFTER intent" — a pre-auth accept click was
  // recorded in sessionStorage; once the user is back here authenticated,
  // finish the join without demanding a second click.
  // WHY no membership guard: an already-member visitor with a stale intent
  // fires one redundant join that 409s — which useAcceptInvite maps to
  // success, converging on the same onDone. Guarding would lift membership
  // state out of the authed subtree for a rare, self-healing case.
  useEffect(() => {
    if (!isAuthed || serverId === undefined || !hasInviteIntent(code)) return
    if (!acceptIsIdle) return

    clearInviteIntent(code)
    acceptMutate(
      { serverId, code },
      {
        onSuccess: (joinedServerId) => onDone(joinedServerId),
      },
    )
  }, [isAuthed, serverId, code, acceptIsIdle, acceptMutate, onDone])

  // WHY: Already-a-member visitors skip the accept step entirely — the CTA
  // would only round-trip to a 409. Clear any stale intent so the auto-join
  // effect cannot re-fire on a later visit to the same code.
  const handleAlreadyMember = useCallback(
    (memberServerId: string) => {
      clearInviteIntent(code)
      onDone(memberServerId)
    },
    [code, onDone],
  )

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

  // WHY compute once: skip the inline error on a plan gate (joined_servers /
  // members caps) — those open the UpgradeModal centrally via the MutationCache,
  // so an inline error would be duplicate feedback (mirrors emoji-settings-tab,
  // ADR-045). Shared by both branches so the suppression can never diverge.
  const joinError =
    acceptInvite.isError && !isPlanGateError(acceptInvite.error)
      ? getApiErrorDetail(acceptInvite.error, t('joinFailed'))
      : null

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

          {preview.isSuccess && !isAuthed && (
            <InvitePreviewCard
              preview={preview.data}
              isAuthed={isAuthed}
              isJoining={acceptInvite.isPending}
              joinError={joinError}
              onAccept={handleAccept}
            />
          )}

          {preview.isSuccess && isAuthed && (
            <AuthedInviteBody
              preview={preview.data}
              isJoining={acceptInvite.isPending}
              joinError={joinError}
              onAccept={handleAccept}
              onAlreadyMember={handleAlreadyMember}
            />
          )}

          {/* WHY web only: inside Tauri this page IS the desktop app — the
              link would be a no-op loop. The harmony:// scheme is registered
              by the desktop install; browsers no-op cleanly when it isn't. */}
          {preview.isSuccess && !isTauri() && (
            <a
              href={`harmony://invite/${code}`}
              className="text-center text-xs text-default-400 underline-offset-2 hover:underline"
              data-test="invite-open-in-app"
            >
              {t('openInDesktopApp')}
            </a>
          )}
        </CardBody>
      </Card>
    </div>
  )
}

/**
 * Authenticated branch — membership is checked BEFORE offering the CTA so an
 * existing member goes straight into the server (no accept round-trip).
 *
 * WHY a separate component: `useServers` hits an authenticated endpoint; the
 * unauthenticated landing must never mount it (a 401 would trip the global
 * interceptor). Conditional rendering keeps the hook behind the auth gate.
 * WHY fall back to the card on servers-query failure: the accept path treats
 * 409 already-a-member as success, so the CTA remains a correct (one click
 * slower) degradation — never a dead end.
 */
function AuthedInviteBody({
  preview,
  isJoining,
  joinError,
  onAccept,
  onAlreadyMember,
}: {
  preview: InvitePreviewResponse
  isJoining: boolean
  joinError: string | null
  onAccept: () => void
  onAlreadyMember: (memberServerId: string) => void
}) {
  const servers = useServers()
  const isMember = servers.data?.some((server) => server.id === preview.serverId) === true
  const serverId = preview.serverId

  useEffect(() => {
    if (isMember) {
      onAlreadyMember(serverId)
    }
  }, [isMember, serverId, onAlreadyMember])

  // WHY spinner while pending OR member: the accept CTA must not flash for a
  // visitor who is about to be handed straight into the server.
  if (servers.isPending || isMember) {
    return (
      <div className="flex flex-col items-center py-6">
        <Spinner size="lg" color="primary" data-test="invite-loading" />
      </div>
    )
  }

  return (
    <InvitePreviewCard
      preview={preview}
      isAuthed
      isJoining={isJoining}
      joinError={joinError}
      onAccept={onAccept}
    />
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
