import { Button, Card, CardBody, Chip } from '@heroui/react'
import { Compass, LogIn, Plus, UserSearch } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { UserSearchDialog } from '@/features/dms'
import { CreateServerDialog, JoinServerDialog } from '@/features/server-nav'

const TOTAL_STEPS = 3

interface OnboardingFlowProps {
  /** Resolved display name (resolveDisplayName over the current profile). */
  displayName: string
  /**
   * Official server id, or null when unset OR the user is not a member of it
   * (banned users are skipped by auto-join — gate on membership, not env).
   */
  officialServerId: string | null
  /** Selects the official server + completes onboarding. */
  onExploreOfficial: (serverId: string) => void
  /** Completes onboarding + selects the newly created server. */
  onServerCreated: (serverId: string) => void
  /** Completes onboarding + selects the newly joined server. */
  onServerJoined: (serverId: string) => void
  /** Completes onboarding + opens the newly created DM. */
  onDmStarted: (serverId: string, channelId: string) => void
  /** Writes the completion flag (skip/done paths). */
  onComplete: () => void
}

/** WHY: Decorative dots — the accessible position is announced by the heading. */
function StepDots({ step }: { step: number }) {
  return (
    <div aria-hidden className="mt-10 flex items-center gap-2">
      {Array.from({ length: TOTAL_STEPS }, (_, i) => i).map((i) => (
        <span
          key={i}
          className={`h-2 w-2 rounded-full transition-colors ${
            i === step ? 'bg-primary' : 'bg-default-300'
          }`}
        />
      ))}
    </div>
  )
}

/**
 * WHY: One-time 3-step guided first-run flow (Welcome → First server → Find
 * people). Replaces the main content area exactly like WelcomeScreen does —
 * the ServerList rail stays mounted (Discord parity). Every step is skippable;
 * every terminal path writes `onboardingCompleted = true` exactly once via
 * the callbacks. Step state is pure ephemeral UI state (not a cache shadow —
 * ADR-045 does not apply).
 */
export function OnboardingFlow({
  displayName,
  officialServerId,
  onExploreOfficial,
  onServerCreated,
  onServerJoined,
  onDmStarted,
  onComplete,
}: OnboardingFlowProps) {
  const { t } = useTranslation('onboarding')
  const [step, setStep] = useState<0 | 1 | 2>(0)
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [isJoinOpen, setIsJoinOpen] = useState(false)
  const [isSearchOpen, setIsSearchOpen] = useState(false)
  const headingRef = useRef<HTMLHeadingElement>(null)

  // WHY: Move focus to the step heading on mount so screen readers land on
  // the flow (§5.6). Step CHANGES are announced by aria-live on the heading —
  // re-focusing on every step would double-announce.
  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  const stepTitles = [t('welcomeTitle'), t('step2Title'), t('step3Title')] as const

  return (
    <section
      data-test="onboarding-flow"
      aria-label={t('welcomeTitle')}
      className="flex h-full w-full flex-1 flex-col items-center justify-center overflow-y-auto bg-background"
    >
      {step === 0 && (
        <img
          src="/brand/logo_vertical_dark.png"
          alt="Harmony"
          className="h-32 w-auto animate-[fade-in_0.6s_ease-out_both]"
        />
      )}

      {/* Step heading — the single live announce point */}
      <div className="mt-6 flex items-center gap-3 animate-[fade-in-up_0.5s_ease-out_0.15s_both]">
        <h1
          ref={headingRef}
          tabIndex={-1}
          aria-live="polite"
          className="text-4xl font-bold tracking-tight text-foreground outline-none"
        >
          {stepTitles[step]}
          <span className="sr-only">
            {' '}
            {t('stepAnnounce', { current: step + 1, total: TOTAL_STEPS })}
          </span>
        </h1>
        {step === 0 && (
          <Chip color="secondary" size="sm" variant="dot">
            {t('alphaLabel', { ns: 'common' })}
          </Chip>
        )}
      </div>

      {step === 0 && (
        <>
          {/* WHY guard: profile may still be loading — an empty-name greeting reads broken */}
          {displayName !== '' && (
            <p className="mt-3 max-w-md text-center text-lg text-default-500 animate-[fade-in-up_0.5s_ease-out_0.25s_both]">
              {t('welcomeGreeting', { name: displayName })}
            </p>
          )}
          <p className="mt-2 max-w-md text-center text-default-500 animate-[fade-in-up_0.5s_ease-out_0.3s_both]">
            {officialServerId !== null ? t('welcomeBody') : t('welcomeBodyNoOfficial')}
          </p>
          <div className="mt-10 flex flex-row items-center gap-3 animate-[fade-in-up_0.5s_ease-out_0.4s_both]">
            {officialServerId !== null && (
              <Button
                data-test="onboarding-explore-official"
                color="primary"
                size="lg"
                startContent={<Compass className="h-5 w-5" />}
                onPress={() => onExploreOfficial(officialServerId)}
              >
                {t('exploreOfficialCta')}
              </Button>
            )}
            <Button
              data-test="onboarding-next"
              variant={officialServerId !== null ? 'flat' : 'solid'}
              color={officialServerId !== null ? 'default' : 'primary'}
              size="lg"
              onPress={() => setStep(1)}
            >
              {t('next')}
            </Button>
          </div>
        </>
      )}

      {step === 1 && (
        <>
          <p className="mt-3 max-w-md text-center text-lg text-default-500">{t('step2Subtitle')}</p>
          <div className="mt-10 flex flex-row gap-4">
            <Card
              data-test="onboarding-create-card"
              isPressable
              onPress={() => setIsCreateOpen(true)}
              className="w-64 border border-divider bg-content1 transition-transform hover:scale-[1.02]"
            >
              <CardBody className="gap-3 p-5">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-success/10">
                  <Plus className="h-6 w-6 text-success" />
                </div>
                <p className="text-lg font-semibold text-foreground">
                  {t('welcomeCreateTitle', { ns: 'servers' })}
                </p>
                <p className="text-sm text-default-500">
                  {t('welcomeCreateDescription', { ns: 'servers' })}
                </p>
              </CardBody>
            </Card>

            <Card
              data-test="onboarding-join-card"
              isPressable
              onPress={() => setIsJoinOpen(true)}
              className="w-64 border border-divider bg-content1 transition-transform hover:scale-[1.02]"
            >
              <CardBody className="gap-3 p-5">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10">
                  <LogIn className="h-6 w-6 text-primary" />
                </div>
                <p className="text-lg font-semibold text-foreground">
                  {t('welcomeJoinTitle', { ns: 'servers' })}
                </p>
                <p className="text-sm text-default-500">
                  {t('welcomeJoinDescription', { ns: 'servers' })}
                </p>
              </CardBody>
            </Card>
          </div>
          <div className="mt-8 flex flex-row items-center gap-3">
            <Button data-test="onboarding-back" variant="light" onPress={() => setStep(0)}>
              {t('back')}
            </Button>
            <Button data-test="onboarding-skip" variant="flat" onPress={() => setStep(2)}>
              {t('skip')}
            </Button>
          </div>
        </>
      )}

      {step === 2 && (
        <>
          <p className="mt-3 max-w-md text-center text-lg text-default-500">{t('step3Subtitle')}</p>
          <div className="mt-10">
            <Card
              data-test="onboarding-find-people"
              isPressable
              onPress={() => setIsSearchOpen(true)}
              className="w-64 border border-divider bg-content1 transition-transform hover:scale-[1.02]"
            >
              <CardBody className="gap-3 p-5">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10">
                  <UserSearch className="h-6 w-6 text-primary" />
                </div>
                <p className="text-lg font-semibold text-foreground">{t('findPeopleCta')}</p>
                <p className="text-sm text-default-500">{t('findPeopleCardBody')}</p>
              </CardBody>
            </Card>
          </div>
          <div className="mt-8 flex flex-row items-center gap-3">
            <Button data-test="onboarding-back" variant="light" onPress={() => setStep(1)}>
              {t('back')}
            </Button>
            <Button data-test="onboarding-done" color="primary" onPress={() => onComplete()}>
              {t('done')}
            </Button>
          </div>
        </>
      )}

      <StepDots step={step} />

      <CreateServerDialog
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        onCreated={(serverId) => {
          setIsCreateOpen(false)
          onServerCreated(serverId)
        }}
      />

      <JoinServerDialog
        isOpen={isJoinOpen}
        onClose={() => setIsJoinOpen(false)}
        onJoined={(serverId) => {
          setIsJoinOpen(false)
          onServerJoined(serverId)
        }}
      />

      <UserSearchDialog
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
        onDmCreated={(serverId, channelId) => {
          setIsSearchOpen(false)
          onDmStarted(serverId, channelId)
        }}
      />
    </section>
  )
}
