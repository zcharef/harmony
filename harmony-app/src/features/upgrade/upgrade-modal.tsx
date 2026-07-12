import {
  Button,
  Chip,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
} from '@heroui/react'
import { Check, Sparkles } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { Plan } from '@/lib/api'
import type { PlanGateError } from '@/lib/plan-gate'
import { usePaywallEvents } from './hooks/use-paywall-events'
import {
  BYTE_RESOURCES,
  formatResourceLimit,
  PLAN_ORDER,
  PLAN_PERKS,
  RESOURCE_LIMITS,
  UPGRADE_EMAIL,
} from './lib/plan-perks'
import { useUpgradeModalStore } from './stores/upgrade-modal-store'

/** WHY: per-request caps read wrong with "you've used all N" phrasing. */
const PER_REQUEST_RESOURCES = new Set(['attachments_per_message'])

function headlineKey(gate: PlanGateError): string {
  if (gate.code === 'FEATURE_NOT_IN_PLAN') {
    return 'headline.feature'
  }
  if (BYTE_RESOURCES.has(gate.resource)) {
    return 'headline.limitBytes'
  }
  if (PER_REQUEST_RESOURCES.has(gate.resource)) {
    return 'headline.limitPerRequest'
  }
  return 'headline.limit'
}

/**
 * The upgrade paywall — opened centrally whenever any API call is rejected
 * with FEATURE_NOT_IN_PLAN or PLAN_LIMIT_REACHED (see App.tsx mutation cache).
 *
 * Context-aware: headline names the blocked action, each tier card shows the
 * blocked resource's real limit for that tier, and the lowest unlocking tier
 * is highlighted with the single strong CTA. Until Stripe exists, the CTA is
 * a mailto that reads like checkout (upgrade-paywall epic).
 */
export function UpgradeModal() {
  const { t } = useTranslation('upgrade')
  const gate = useUpgradeModalStore((state) => state.gate)
  const close = useUpgradeModalStore((state) => state.close)
  const paywallEvents = usePaywallEvents()
  // WHY refs: paywall_viewed must fire once per open (not per re-render),
  // and a CTA click must not also count the close as a dismissal.
  const viewedGateRef = useRef<PlanGateError | null>(null)
  const ctaClickedRef = useRef(false)

  const emitEvent = paywallEvents.mutate
  useEffect(() => {
    if (gate !== null && viewedGateRef.current !== gate) {
      viewedGateRef.current = gate
      ctaClickedRef.current = false
      emitEvent({ name: 'paywall_viewed', gate })
    }
  }, [gate, emitEvent])

  if (gate === null) {
    return null
  }

  const resourceLabel = t(`resources.${gate.resource}`)
  const recommendedLabel = t(`plans.${gate.requiredPlan}`)
  const currentLabel = t(`plans.${gate.currentPlan}`)
  const subtitleKey = gate.code === 'FEATURE_NOT_IN_PLAN' ? 'subtitle.feature' : 'subtitle.limit'
  const limitLabel = BYTE_RESOURCES.has(gate.resource)
    ? formatResourceLimit(gate.resource, gate.limit)
    : String(gate.limit)

  const mailtoHref = `mailto:${UPGRADE_EMAIL}?subject=${encodeURIComponent(
    t('mailSubject', { plan: recommendedLabel }),
  )}&body=${encodeURIComponent(
    t('mailBody', {
      plan: recommendedLabel,
      resource: resourceLabel,
      currentPlan: currentLabel,
    }),
  )}`

  function handleDismiss() {
    if (gate !== null && !ctaClickedRef.current) {
      emitEvent({ name: 'paywall_dismissed', gate })
    }
    close()
  }

  function handleCtaClick() {
    if (gate === null) {
      return
    }
    ctaClickedRef.current = true
    emitEvent({ name: 'paywall_cta_clicked', gate, targetPlan: gate.requiredPlan })
  }

  return (
    <Modal
      isOpen
      onClose={handleDismiss}
      size="3xl"
      data-test="upgrade-modal"
      classNames={{ base: 'overflow-visible' }}
    >
      <ModalContent>
        <ModalHeader className="flex flex-col gap-1 pt-6">
          {/* WHY first-letter:uppercase: feature headlines start with the
              resource noun ("custom emoji are…") — sentence-case it without
              distorting the noun elsewhere. Flex items are block containers,
              so ::first-letter applies. */}
          <span
            className="text-lg font-semibold first-letter:uppercase"
            data-test="upgrade-headline"
          >
            {t(headlineKey(gate), {
              resource: resourceLabel,
              plan: gate.code === 'FEATURE_NOT_IN_PLAN' ? recommendedLabel : currentLabel,
              limit: limitLabel,
            })}
          </span>
          <span className="text-sm font-normal text-default-500">
            {t(subtitleKey, { plan: recommendedLabel })}
          </span>
        </ModalHeader>
        <ModalBody className="pb-2">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {PLAN_ORDER.map((plan, index) => (
              <TierCard
                key={plan}
                plan={plan}
                gate={gate}
                mailtoHref={mailtoHref}
                onCtaClick={handleCtaClick}
                enterDelayClass={CARD_ENTER_DELAYS[index] ?? ''}
              />
            ))}
          </div>
        </ModalBody>
        <ModalFooter className="justify-center">
          <Button
            variant="light"
            size="sm"
            className="text-default-400"
            onPress={handleDismiss}
            data-test="upgrade-maybe-later"
          >
            {t('maybeLater')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
}

/** WHY staggered classes (not inline style): 30-80ms cascade per card; inline styles are banned. */
const CARD_ENTER_DELAYS = [
  '[animation-delay:0ms]',
  '[animation-delay:60ms]',
  '[animation-delay:120ms]',
] as const

interface TierCardProps {
  plan: Plan
  gate: PlanGateError
  mailtoHref: string
  onCtaClick: () => void
  enterDelayClass: string
}

function TierCard({ plan, gate, mailtoHref, onCtaClick, enterDelayClass }: TierCardProps) {
  const { t } = useTranslation('upgrade')
  const isRecommended = plan === gate.requiredPlan
  const isCurrent = plan === gate.currentPlan
  const tierLimit = RESOURCE_LIMITS[gate.resource]?.[plan]

  return (
    <div
      className={`relative flex flex-col gap-3 rounded-large p-4 pt-5 transition-transform duration-150 ease-out motion-safe:animate-[fade-in-up_240ms_cubic-bezier(0.23,1,0.32,1)_both] ${enterDelayClass} ${
        isRecommended
          ? 'bg-content2 ring-2 ring-primary shadow-lg shadow-primary/20 hover:-translate-y-0.5'
          : 'border border-default-100 bg-content1 hover:-translate-y-0.5'
      }`}
      data-test={`upgrade-tier-${plan}`}
    >
      {isRecommended ? (
        <Chip
          color="primary"
          size="sm"
          startContent={<Sparkles className="h-3 w-3" />}
          className="absolute -top-2.5 left-1/2 -translate-x-1/2 gap-1 px-2"
          data-test="upgrade-recommended-chip"
        >
          {t('recommended')}
        </Chip>
      ) : null}

      <div className="flex flex-col gap-0.5">
        <div className="flex items-center justify-between">
          <span className={`text-base font-semibold ${isRecommended ? 'text-primary' : ''}`}>
            {t(`plans.${plan}`)}
          </span>
          {isCurrent ? (
            <Chip size="sm" variant="flat" className="text-tiny text-default-500">
              {t('currentPlan')}
            </Chip>
          ) : null}
        </div>
        <span className="text-xs text-default-400">{t(`taglines.${plan}`)}</span>
      </div>

      {tierLimit !== undefined ? (
        <div
          className={`flex items-baseline justify-between rounded-medium px-2.5 py-2 ${
            isRecommended ? 'bg-primary/10' : 'bg-content2'
          }`}
          data-test={`upgrade-resource-row-${plan}`}
        >
          <span className="text-xs capitalize text-default-500">
            {t(`resources.${gate.resource}`)}
          </span>
          <span
            className={`text-sm font-semibold tabular-nums ${
              tierLimit === 0
                ? 'text-default-300'
                : isRecommended
                  ? 'text-primary'
                  : 'text-default-600'
            }`}
          >
            {tierLimit === 0
              ? t('blockedResourceNone')
              : formatResourceLimit(gate.resource, tierLimit)}
          </span>
        </div>
      ) : null}

      <ul className="flex flex-1 flex-col gap-1.5">
        {PLAN_PERKS[plan].map((perk) => (
          <li key={perk.key} className="flex items-start gap-2 text-sm text-default-500">
            <Check
              className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
                isRecommended ? 'text-primary' : 'text-default-400'
              }`}
            />
            <span>{t(`perks.${perk.key}`, perk.values)}</span>
          </li>
        ))}
      </ul>

      {isRecommended ? (
        <Button
          as="a"
          href={mailtoHref}
          color="primary"
          fullWidth
          className="font-semibold"
          onPress={onCtaClick}
          data-test="upgrade-cta"
        >
          {t('cta', { plan: t(`plans.${plan}`) })}
        </Button>
      ) : null}
    </div>
  )
}
