import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast, toastApiError } from '@/lib/toast'

const { addToastMock } = vi.hoisted(() => ({ addToastMock: vi.fn() }))

vi.mock('@heroui/react', () => ({
  addToast: addToastMock,
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

function planGateProblem(code: string) {
  return {
    type: 'about:blank',
    title: 'Feature Not In Plan',
    status: 403,
    detail: 'custom emoji are not included in the free plan',
    code,
    plan_gate: {
      resource: 'custom_emoji',
      current_plan: 'free',
      limit: 0,
      required_plan: 'supporter',
    },
  }
}

describe('toastApiError', () => {
  beforeEach(() => {
    addToastMock.mockClear()
  })

  it('suppresses the toast for FEATURE_NOT_IN_PLAN (UpgradeModal owns it)', () => {
    toastApiError(planGateProblem('FEATURE_NOT_IN_PLAN'), 'fallback')
    expect(addToastMock).not.toHaveBeenCalled()
  })

  it('suppresses the toast for PLAN_LIMIT_REACHED (UpgradeModal owns it)', () => {
    toastApiError(planGateProblem('PLAN_LIMIT_REACHED'), 'fallback')
    expect(addToastMock).not.toHaveBeenCalled()
  })

  it('keeps the toast with the API detail for other 4xx errors', () => {
    toastApiError({ status: 409, detail: 'Name already taken' }, 'fallback')
    expect(addToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Name already taken', color: 'danger' }),
    )
  })

  it('keeps the toast with the fallback for 5xx / unknown errors', () => {
    toastApiError({ status: 500, detail: 'stack trace' }, 'fallback')
    expect(addToastMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'fallback' }))
  })
})

describe('toast facade', () => {
  beforeEach(() => {
    addToastMock.mockClear()
  })

  it('toast.error still always shows', () => {
    toast.error('boom')
    expect(addToastMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'boom' }))
  })
})
