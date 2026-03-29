/**
 * Reusable error empty state for panels (channels, DMs, members, chat).
 *
 * WHY: Replaces scattered red "Error" text with a consistent, soft empty state.
 * Uses muted colors (not red) because the global ConnectionBanner already
 * communicates the alarm level — panel errors should be soft guidance.
 * Generalizes the icon + message pattern from member-list.tsx:93-100.
 */

import { Button } from '@heroui/react'

interface ErrorStateProps {
  icon: React.ReactNode
  message: string
  onRetry?: () => void
  retryLabel?: string
  /** WHY: Shows a loading spinner on the retry button while the query refetches. */
  isRetrying?: boolean
}

export function ErrorState({
  icon,
  message,
  onRetry,
  retryLabel = 'Try again',
  isRetrying = false,
}: ErrorStateProps) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-8">
      <div className="text-default-300">{icon}</div>
      <p className="text-center text-sm text-default-500">{message}</p>
      {onRetry !== undefined && (
        <Button
          variant="flat"
          size="sm"
          onPress={onRetry}
          isLoading={isRetrying}
          isDisabled={isRetrying}
        >
          {retryLabel}
        </Button>
      )}
    </div>
  )
}
