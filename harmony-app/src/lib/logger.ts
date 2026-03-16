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

export const logger = {
  error(message: string, context?: Record<string, unknown>) {
    if (import.meta.env.DEV) {
      // biome-ignore lint/suspicious/noConsole: logger is the only authorized console access
      console.error(message, context)
    }
    // TODO: Sentry.addBreadcrumb({ message, data: context, level: 'error' })
    // Uncomment when @sentry/react is added as a dependency
  },
  warn(message: string, context?: Record<string, unknown>) {
    if (import.meta.env.DEV) {
      // biome-ignore lint/suspicious/noConsole: logger is the only authorized console access
      console.warn(message, context)
    }
  },
  info(message: string, context?: Record<string, unknown>) {
    if (import.meta.env.DEV) {
      // biome-ignore lint/suspicious/noConsole: logger is the only authorized console access
      console.info(message, context)
    }
  },
}
