import { useMutation } from '@tanstack/react-query'
import type { ClientAnalyticsEventName } from '@/lib/api'
import { recordEvent } from '@/lib/api'
import { logger } from '@/lib/logger'
import type { PlanGateError } from '@/lib/plan-gate'

export interface PaywallEventInput {
  name: ClientAnalyticsEventName
  gate: PlanGateError
  /** The tier the CTA targets — only for `paywall_cta_clicked`. */
  targetPlan?: string
}

/**
 * Fire-and-forget paywall analytics (paywall_viewed / cta_clicked / dismissed).
 *
 * WHY silent onError: analytics is a background operation — a failed emit
 * must never surface to the user (ADR-045), only leave a breadcrumb.
 */
export function usePaywallEvents() {
  return useMutation({
    mutationFn: async ({ name, gate, targetPlan }: PaywallEventInput) => {
      await recordEvent({
        body: {
          name,
          resource: gate.resource,
          code: gate.code,
          currentPlan: gate.currentPlan,
          recommendedPlan: gate.requiredPlan,
          // WHY conditional spread: omit the key entirely when absent —
          // never send an explicit undefined/null.
          ...(targetPlan !== undefined ? { targetPlan } : {}),
        },
        throwOnError: true,
      })
    },
    onError: (error) => {
      logger.warn('paywall_event_emit_failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    },
  })
}
