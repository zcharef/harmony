import emojiData from '@emoji-mart/data'
import type { PopoverProps } from '@heroui/react'
import { Popover, PopoverContent, PopoverTrigger, Spinner } from '@heroui/react'
import { lazy, type ReactNode, Suspense, useCallback, useMemo } from 'react'
import { ErrorBoundary } from 'react-error-boundary'
import { useTranslation } from 'react-i18next'
import { buildCustomCategory, toEmojiToken, useServerEmojis } from '@/features/server-emojis'
import { logger } from '@/lib/logger'

// WHY lazy: @emoji-mart/react is heavy and only needed once a picker opens.
// Module-level singleton — every popover instance shares the same lazy chunk,
// and PopoverContent children only mount when the popover is open.
const EmojiPicker = lazy(() => import('@emoji-mart/react'))

/**
 * emoji-mart selection shape. Unicode emoji carry `native`; a custom (server)
 * emoji has NO `native` — it carries `id` (the emoji name) and `src`.
 */
interface EmojiMartSelection {
  native?: string
  id?: string
}

interface EmojiPickerPopoverProps {
  isOpen: boolean
  onOpenChange: (isOpen: boolean) => void
  /**
   * WHY: Receives either the native emoji character (e.g. "🔥") or a custom
   * `:name:` token. The popover closes itself after selection.
   */
  onEmojiSelect: (emoji: string) => void
  /** When set, the server's custom emoji appear as a "Server" category. */
  serverId?: string | null
  placement?: PopoverProps['placement']
  /** The trigger element. Must accept a ref (HeroUI Button or a native DOM element). */
  children: ReactNode
}

/**
 * WHY: Single picker implementation for every emoji entry point (composer
 * insertion, message hover react button, ReactionBar "+" pill). One pattern
 * per concern — no parallel picker mounts, and emoji-mart stays lazy-loaded.
 *
 * Passing `serverId` surfaces that server's custom emoji as an emoji-mart
 * `custom` category; selecting one emits its `:name:` token (custom emoji have
 * no `native` char), which the composer inserts and reactions store verbatim.
 */
export function EmojiPickerPopover({
  isOpen,
  onOpenChange,
  onEmojiSelect,
  serverId = null,
  placement = 'top-end',
  children,
}: EmojiPickerPopoverProps) {
  const { data } = useServerEmojis(serverId)
  const custom = useMemo(() => buildCustomCategory(data?.items ?? []), [data])

  const handleSelect = useCallback(
    (emoji: EmojiMartSelection) => {
      // WHY branch: custom emoji carry no `native` char — emit the `:name:`
      // token from `id` instead. Unicode emoji pass their native char through.
      const value =
        typeof emoji.native === 'string' && emoji.native.length > 0
          ? emoji.native
          : emoji.id !== undefined
            ? toEmojiToken(emoji.id)
            : null
      if (value === null) return
      onEmojiSelect(value)
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
            <EmojiPicker
              data={emojiData}
              custom={custom.length > 0 ? custom : undefined}
              onEmojiSelect={handleSelect}
            />
          </Suspense>
        </ErrorBoundary>
      </PopoverContent>
    </Popover>
  )
}
