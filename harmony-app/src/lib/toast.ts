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
import { logger } from '@/lib/logger'

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
