/**
 * Sentry initialization — crash reporting and proactive alerting (ADR-028).
 *
 * WHY: Dual web/desktop deployment requires platform-aware init:
 * - Web (Cloudflare Pages): standard @sentry/browser transport
 * - Desktop (Tauri): tauri-plugin-sentry auto-injects and routes through Rust backend,
 *   so we skip browser-side init to avoid double initialization.
 *
 * Sentry captures ONLY: Error Boundary crashes, unhandled rejections, panics.
 * 4xx errors are NEVER sent to Sentry (ADR-028).
 */

import * as Sentry from '@sentry/browser'
import { isTauri } from './platform'

export function initSentry(dsn: string | undefined): void {
  if (dsn === undefined || dsn.length === 0) {
    return
  }

  // WHY: In Tauri, the plugin already initializes @sentry/browser via auto-injection
  // with a custom transport that routes events through the Rust backend.
  // Initializing again would create a second client and duplicate events.
  if (isTauri()) {
    return
  }

  Sentry.init({
    dsn,
    // WHY: Only capture errors and unhandled rejections. No performance monitoring
    // on the client — the API handles server-side tracing via OpenTelemetry.
    tracesSampleRate: 0,
    beforeSend(event) {
      // WHY: 4xx HTTP errors are expected business logic, not bugs (ADR-028).
      // They should never reach Sentry — only breadcrumbs via the logger.
      const statusCode = event.contexts?.response?.status_code
      if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
        return null
      }
      return event
    },
  })
}

export { Sentry }
