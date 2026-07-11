/**
 * Toast notification facade — thin wrapper over HeroUI's addToast (ADR-045).
 *
 * WHY a facade: Provides a minimal `toast.error()` / `toast.success()` API
 * so call-sites don't repeat HeroUI's verbose addToast config every time.
 * Also co-locates the structured logger breadcrumb with the user notification
 * to satisfy ADR-045's "log + feedback" requirement in one call.
 *
 * Usage:
 *   import { toast } from '@/lib/toast'
 *   toast.error('Could not open DM')
 *   toast.success('Server created')
 *   toast.info('Copied to clipboard')
 */

import { addToast } from '@heroui/react'
import { getApiErrorDetail } from '@/lib/api-error'
import { logger } from '@/lib/logger'
import { isPlanGateError } from '@/lib/plan-gate'

const DEFAULT_TIMEOUT = 5000

export const toast = {
  error(message: string, options?: { description?: string; context?: Record<string, unknown> }) {
    logger.error(message, options?.context)
    addToast({
      title: message,
      description: options?.description,
      color: 'danger',
      severity: 'danger',
      timeout: DEFAULT_TIMEOUT,
    })
  },

  success(message: string, options?: { description?: string }) {
    addToast({
      title: message,
      description: options?.description,
      color: 'success',
      severity: 'success',
      timeout: DEFAULT_TIMEOUT,
    })
  },

  info(message: string, options?: { description?: string }) {
    addToast({
      title: message,
      description: options?.description,
      color: 'primary',
      severity: 'primary',
      timeout: DEFAULT_TIMEOUT,
    })
  },
}

/**
 * Error toast for a failed API call — the shared exit point mutations
 * route their `onError` feedback through.
 *
 * WHY: Plan-gate rejections (FEATURE_NOT_IN_PLAN / PLAN_LIMIT_REACHED)
 * are owned by the UpgradeModal, opened centrally from the mutation
 * cache — showing the red toast on top of it would double-punish the
 * user. Every other error keeps the standard toast with the API's
 * 4xx detail (or the caller's fallback).
 */
export function toastApiError(
  error: unknown,
  fallback: string,
  options?: { context?: Record<string, unknown> },
) {
  if (isPlanGateError(error)) {
    return
  }
  toast.error(getApiErrorDetail(error, fallback), { context: options?.context })
}
