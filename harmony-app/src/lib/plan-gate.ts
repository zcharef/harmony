/**
 * Plan-gate error detection.
 *
 * WHY: The API rejects plan-gated actions with RFC 9457 ProblemDetails
 * carrying a machine code (`FEATURE_NOT_IN_PLAN` / `PLAN_LIMIT_REACHED`)
 * plus a structured `plan_gate` extension. This module is the single
 * parser for that contract — the upgrade paywall and the toast layer
 * both narrow through here so their decisions can never diverge.
 */

import type { Plan } from '@/lib/api'

export const PLAN_GATE_CODES = ['FEATURE_NOT_IN_PLAN', 'PLAN_LIMIT_REACHED'] as const

export type PlanGateCode = (typeof PLAN_GATE_CODES)[number]

/** Parsed, fully-populated plan-gate rejection — safe to render a paywall from. */
export interface PlanGateError {
  code: PlanGateCode
  /** Stable resource key from the API (e.g. `custom_emoji`, `active_invites`). */
  resource: string
  currentPlan: Plan
  /** The current plan's limit for the resource (0 = feature not included). */
  limit: number
  /** Lowest tier that unlocks or raises the blocked resource. */
  requiredPlan: Plan
}

const PLANS = ['free', 'supporter', 'creator'] as const

function isPlan(value: unknown): value is Plan {
  return typeof value === 'string' && (PLANS as readonly string[]).includes(value)
}

function isPlanGateCode(value: unknown): value is PlanGateCode {
  return typeof value === 'string' && (PLAN_GATE_CODES as readonly string[]).includes(value)
}

/**
 * Extracts a plan-gate rejection from a thrown API error.
 *
 * Returns `null` for anything else — including plan-gate rejections
 * without a `required_plan` (nothing to upsell, e.g. already at the top
 * tier's ceiling); those fall back to the regular error toast.
 */
export function extractPlanGateError(error: unknown): PlanGateError | null {
  if (typeof error !== 'object' || error === null) {
    return null
  }
  const problem = error as Record<string, unknown>
  if (problem.status !== 403 || !isPlanGateCode(problem.code)) {
    return null
  }
  const gate = problem.plan_gate
  if (typeof gate !== 'object' || gate === null) {
    return null
  }
  const details = gate as Record<string, unknown>
  if (
    typeof details.resource !== 'string' ||
    typeof details.limit !== 'number' ||
    !isPlan(details.current_plan) ||
    !isPlan(details.required_plan)
  ) {
    return null
  }
  return {
    code: problem.code,
    resource: details.resource,
    currentPlan: details.current_plan,
    limit: details.limit,
    requiredPlan: details.required_plan,
  }
}

/** Whether a thrown API error is a plan-gate rejection the paywall owns. */
export function isPlanGateError(error: unknown): boolean {
  return extractPlanGateError(error) !== null
}
