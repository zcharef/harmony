import { type FallbackProps, ErrorBoundary as ReactErrorBoundary } from 'react-error-boundary'

function DefaultErrorFallback({ error, resetErrorBoundary }: FallbackProps) {
  // WHY: The generated SDK wraps RFC 9457 ProblemDetails in error.body
  const err = error as Record<string, unknown> | undefined
  const body = err?.body as Record<string, unknown> | undefined
  const detail = body?.detail ?? (err?.message as string) ?? 'An unexpected error occurred'
  const title = (body?.title as string) ?? 'Something went wrong'

  return (
    <div className="flex flex-col items-center justify-center gap-4 p-8">
      <h2 className="text-lg font-semibold text-destructive">{title}</h2>
      <p className="text-sm text-muted-foreground">{String(detail)}</p>
      <button
        type="button"
        onClick={resetErrorBoundary}
        className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90"
      >
        Try again
      </button>
    </div>
  )
}

export function FeatureErrorBoundary({ children }: { children: React.ReactNode }) {
  return (
    <ReactErrorBoundary FallbackComponent={DefaultErrorFallback}>{children}</ReactErrorBoundary>
  )
}
