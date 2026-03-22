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
    // WHY: Errors are always logged — in dev they appear in devtools,
    // in production they appear in Tauri's log output for diagnostics.
    // TODO: Route to Sentry.captureException when @sentry/react is added.
    console.error(message, context)
  },
  warn(message: string, context?: Record<string, unknown>) {
    if (import.meta.env.DEV) {
      console.warn(message, context)
    }
  },
  info(message: string, context?: Record<string, unknown>) {
    if (import.meta.env.DEV) {
      console.info(message, context)
    }
  },
}
