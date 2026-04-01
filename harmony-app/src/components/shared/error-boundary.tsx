/**
 * Feature-level error boundary — catches React render crashes (ADR-034).
 *
 * WHY: A crash in one panel (e.g., ChatArea) should not take down the entire app.
 * Each major panel is wrapped independently so failures are isolated.
 *
 * Monitoring: Render crashes are the ONLY client errors sent to Sentry via
 * captureException (ADR-028). All other errors are breadcrumbs only.
 *
 * Follows the same HeroUI + Lucide pattern as update-notification.tsx and
 * error-state.tsx for visual consistency.
 */

import { Button, Card, CardBody } from '@heroui/react'
import { AlertTriangle } from 'lucide-react'
import type { ReactNode } from 'react'
import type { FallbackProps } from 'react-error-boundary'
import { ErrorBoundary } from 'react-error-boundary'
import { useTranslation } from 'react-i18next'
import { logger } from '@/lib/logger'
import { Sentry } from '@/lib/sentry'

/**
 * WHY: Separated from FeatureErrorBoundary so it can be tested independently
 * and reused if a different boundary configuration is needed in the future.
 */
export function ErrorFallback({ resetErrorBoundary }: FallbackProps) {
  const { t } = useTranslation('common')

  return (
    <div className="flex h-full w-full items-center justify-center bg-background p-4">
      <Card className="max-w-sm border border-divider bg-content1">
        <CardBody className="flex flex-col items-center gap-3 p-6">
          <div className="text-danger">
            <AlertTriangle className="h-10 w-10" />
          </div>
          <p className="text-center text-sm font-medium text-foreground">
            {t('somethingWentWrong')}
          </p>
          <p className="text-center text-xs text-foreground-500">{t('anUnexpectedError')}</p>
          <Button color="primary" variant="flat" size="sm" onPress={resetErrorBoundary}>
            {t('tryAgain')}
          </Button>
        </CardBody>
      </Card>
    </div>
  )
}

interface FeatureErrorBoundaryProps {
  children: ReactNode
  /** WHY: Identifies which boundary caught the error in Sentry/logs for triage. */
  name?: string
}

/**
 * Wraps a feature panel so render crashes are isolated, reported to Sentry,
 * and shown as a user-friendly fallback with a retry button.
 */
export function FeatureErrorBoundary({ children, name = 'unknown' }: FeatureErrorBoundaryProps) {
  return (
    <ErrorBoundary
      FallbackComponent={ErrorFallback}
      onError={(error, info) => {
        // WHY: captureException is reserved for render crashes only (ADR-028).
        // This is the ONE place in the client that calls it.
        Sentry.captureException(error, {
          contexts: {
            errorBoundary: {
              name,
              componentStack: info.componentStack ?? 'unavailable',
            },
          },
        })
        logger.error('error_boundary_caught', {
          boundary: name,
          error: error instanceof Error ? error.message : String(error),
        })
      }}
    >
      {children}
    </ErrorBoundary>
  )
}
