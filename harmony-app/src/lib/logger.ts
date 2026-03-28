/**
 * Structured logger — Single authorized location for console.* calls (ADR-042).
 *
 * WHY: Raw console.* is invisible in production. This logger routes to:
 * - Development: browser devtools (for DX)
 * - Production: Sentry breadcrumbs (for observability)
 *
 * All other files use `import { logger } from '@/lib/logger'`.
 * Biome `noConsole: error` enforces this globally.
 */

import { Sentry } from '@/lib/sentry'

export const logger = {
  error(message: string, context?: Record<string, unknown>) {
    // WHY: In production, errors become Sentry breadcrumbs for crash context.
    // NOT captureException — that's reserved for Error Boundary crashes only (ADR-028).
    Sentry.addBreadcrumb({ category: 'logger', level: 'error', message, data: context })
    console.error(message, context)
  },
  warn(message: string, context?: Record<string, unknown>) {
    if (import.meta.env.DEV) {
      console.warn(message, context)
    } else {
      Sentry.addBreadcrumb({ category: 'logger', level: 'warning', message, data: context })
    }
  },
  info(message: string, context?: Record<string, unknown>) {
    if (import.meta.env.DEV) {
      console.info(message, context)
    }
  },
}
