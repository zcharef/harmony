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
  error(message: string, context?: Record<string, unknown>) {
    logger.error(message, context)
    addToast({ title: message, color: 'danger', severity: 'danger', timeout: DEFAULT_TIMEOUT })
  },

  success(message: string) {
    addToast({ title: message, color: 'success', severity: 'success', timeout: DEFAULT_TIMEOUT })
  },

  info(message: string) {
    addToast({ title: message, color: 'primary', severity: 'primary', timeout: DEFAULT_TIMEOUT })
  },
}
