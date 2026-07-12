import { describe, expect, it } from 'vitest'
import { extractPlanGateError, isPlanGateError } from '@/lib/plan-gate'

function planGateProblem(overrides: Record<string, unknown> = {}) {
  return {
    type: 'about:blank',
    title: 'Feature Not In Plan',
    status: 403,
    detail: 'custom emoji are not included in the free plan',
    code: 'FEATURE_NOT_IN_PLAN',
    plan_gate: {
      resource: 'custom_emoji',
      current_plan: 'free',
      limit: 0,
      required_plan: 'supporter',
    },
    ...overrides,
  }
}

describe('extractPlanGateError', () => {
  it('parses a FEATURE_NOT_IN_PLAN rejection', () => {
    expect(extractPlanGateError(planGateProblem())).toEqual({
      code: 'FEATURE_NOT_IN_PLAN',
      resource: 'custom_emoji',
      currentPlan: 'free',
      limit: 0,
      requiredPlan: 'supporter',
    })
  })

  it('parses a PLAN_LIMIT_REACHED rejection', () => {
    const problem = planGateProblem({
      code: 'PLAN_LIMIT_REACHED',
      plan_gate: {
        resource: 'active_invites',
        current_plan: 'free',
        limit: 5,
        required_plan: 'supporter',
      },
    })
    expect(extractPlanGateError(problem)).toEqual({
      code: 'PLAN_LIMIT_REACHED',
      resource: 'active_invites',
      currentPlan: 'free',
      limit: 5,
      requiredPlan: 'supporter',
    })
  })

  it('parses a banner FEATURE_NOT_IN_PLAN rejection (Supporter upsell)', () => {
    const problem = planGateProblem({
      detail: 'profile banner are not included in the free plan',
      plan_gate: {
        resource: 'banner',
        current_plan: 'free',
        limit: 0,
        required_plan: 'supporter',
      },
    })
    // WHY: this is exactly the object App.tsx feeds openUpgradeModal — a banner
    // 403 must produce a gate so the UpgradeModal opens with the Supporter pitch.
    expect(extractPlanGateError(problem)).toEqual({
      code: 'FEATURE_NOT_IN_PLAN',
      resource: 'banner',
      currentPlan: 'free',
      limit: 0,
      requiredPlan: 'supporter',
    })
  })

  it('returns null for other 403 problems (no code)', () => {
    expect(extractPlanGateError(planGateProblem({ code: undefined }))).toBeNull()
  })

  it('returns null for other error codes', () => {
    expect(extractPlanGateError(planGateProblem({ code: 'SOMETHING_ELSE' }))).toBeNull()
  })

  it('returns null when plan_gate details are missing', () => {
    expect(extractPlanGateError(planGateProblem({ plan_gate: undefined }))).toBeNull()
  })

  it('returns null when required_plan is absent (nothing to upsell)', () => {
    const problem = planGateProblem({
      plan_gate: {
        resource: 'owned_servers',
        current_plan: 'creator',
        limit: 25,
      },
    })
    expect(extractPlanGateError(problem)).toBeNull()
  })

  it('returns null for non-403 statuses even with a code', () => {
    expect(extractPlanGateError(planGateProblem({ status: 500 }))).toBeNull()
  })

  it('returns null for non-object errors', () => {
    expect(extractPlanGateError(null)).toBeNull()
    expect(extractPlanGateError('boom')).toBeNull()
    expect(extractPlanGateError(new Error('boom'))).toBeNull()
  })
})

describe('isPlanGateError', () => {
  it('mirrors extractPlanGateError', () => {
    expect(isPlanGateError(planGateProblem())).toBe(true)
    expect(isPlanGateError({ status: 403, detail: 'nope' })).toBe(false)
  })
})
