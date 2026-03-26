import { Button } from '@heroui/react'
import { type FallbackProps, ErrorBoundary as ReactErrorBoundary } from 'react-error-boundary'
import { useTranslation } from 'react-i18next'
import { Sentry } from '@/lib/sentry'

function DefaultErrorFallback({ error, resetErrorBoundary }: FallbackProps) {
  const { t } = useTranslation('common')

  // WHY: The generated SDK wraps RFC 9457 ProblemDetails in error.body
  const err = error as Record<string, unknown> | undefined
  const body = err?.body as Record<string, unknown> | undefined
  const detail = body?.detail ?? (err?.message as string) ?? t('anUnexpectedError')
  const title = (body?.title as string) ?? t('somethingWentWrong')

  return (
    <div className="flex flex-col items-center justify-center gap-4 p-8">
      <h2 className="text-lg font-semibold text-danger">{title}</h2>
      <p className="text-sm text-default-500">{String(detail)}</p>
      <Button color="primary" variant="flat" onPress={resetErrorBoundary}>
        {t('tryAgain')}
      </Button>
    </div>
  )
}

// WHY: React render crashes are the ONE case where captureException is mandatory (ADR-028).
// 4xx/5xx are handled by the API interceptor as breadcrumbs, never as exceptions.
function handleError(error: unknown, info: React.ErrorInfo) {
  Sentry.captureException(error, { extra: { componentStack: info.componentStack } })
}

export function FeatureErrorBoundary({ children }: { children: React.ReactNode }) {
  return (
    <ReactErrorBoundary FallbackComponent={DefaultErrorFallback} onError={handleError}>
      {children}
    </ReactErrorBoundary>
  )
}
