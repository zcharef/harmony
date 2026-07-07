import emojiData from '@emoji-mart/data'
import type { PopoverProps } from '@heroui/react'
import { Popover, PopoverContent, PopoverTrigger, Spinner } from '@heroui/react'
import { lazy, type ReactNode, Suspense, useCallback } from 'react'
import { ErrorBoundary } from 'react-error-boundary'
import { useTranslation } from 'react-i18next'
import { logger } from '@/lib/logger'

// WHY lazy: @emoji-mart/react is heavy and only needed once a picker opens.
// Module-level singleton — every popover instance shares the same lazy chunk,
// and PopoverContent children only mount when the popover is open.
const EmojiPicker = lazy(() => import('@emoji-mart/react'))

interface EmojiPickerPopoverProps {
  isOpen: boolean
  onOpenChange: (isOpen: boolean) => void
  /** WHY: Receives the native emoji character (e.g. "🔥"). The popover closes itself after selection. */
  onEmojiSelect: (emoji: string) => void
  placement?: PopoverProps['placement']
  /** The trigger element. Must accept a ref (HeroUI Button or a native DOM element). */
  children: ReactNode
}

/**
 * WHY: Single picker implementation for every emoji entry point (composer
 * insertion, message hover react button, ReactionBar "+" pill). One pattern
 * per concern — no parallel picker mounts, and emoji-mart stays lazy-loaded.
 */
export function EmojiPickerPopover({
  isOpen,
  onOpenChange,
  onEmojiSelect,
  placement = 'top-end',
  children,
}: EmojiPickerPopoverProps) {
  const handleSelect = useCallback(
    (emoji: { native: string }) => {
      onEmojiSelect(emoji.native)
      onOpenChange(false)
    },
    [onEmojiSelect, onOpenChange],
  )

  const { t } = useTranslation('chat')

  return (
    <Popover isOpen={isOpen} onOpenChange={onOpenChange} placement={placement}>
      <PopoverTrigger>{children}</PopoverTrigger>
      <PopoverContent className="p-0">
        {/* WHY local boundary (not FeatureErrorBoundary): a failed lazy chunk
            is a network problem, not a render crash — breadcrumb only, no
            Sentry (ADR-028). Only the popover degrades; the message list
            stays alive. */}
        <ErrorBoundary
          fallbackRender={() => (
            <p className="p-4 text-xs text-foreground-500">{t('emojiPickerLoadFailed')}</p>
          )}
          onError={(error) => {
            logger.warn('emoji_picker_chunk_failed', {
              error: error instanceof Error ? error.message : String(error),
            })
          }}
        >
          <Suspense fallback={<Spinner size="sm" className="p-4" />}>
            <EmojiPicker data={emojiData} onEmojiSelect={handleSelect} />
          </Suspense>
        </ErrorBoundary>
      </PopoverContent>
    </Popover>
  )
}
