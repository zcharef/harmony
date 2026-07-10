import { Avatar, Popover, PopoverContent, PopoverTrigger, Spinner } from '@heroui/react'
import { useTranslation } from 'react-i18next'
import { resolveDisplayName } from '@/lib/display-name'
import type { MentionCandidate } from '../hooks/use-mention-autocomplete'

interface MentionAutocompleteProps {
  isOpen: boolean
  isLoading: boolean
  results: MentionCandidate[]
  highlightIndex: number
  onSelect: (candidate: MentionCandidate) => void
  /** Called on outside interaction / dismissal. */
  onClose: () => void
}

/** Stable option id — referenced by the textarea's aria-activedescendant. */
export function mentionOptionId(userId: string): string {
  return `mention-option-${userId}`
}

function MentionOptionRow({
  candidate,
  isHighlighted,
  onSelect,
}: {
  candidate: MentionCandidate
  isHighlighted: boolean
  onSelect: (candidate: MentionCandidate) => void
}) {
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: combobox pattern — keyboard interaction lives on the composer textarea (aria-activedescendant)
    <div
      id={mentionOptionId(candidate.userId)}
      role="option"
      // WHY tabIndex -1: option rows are aria-activedescendant targets — they
      // must be programmatically addressable but never in the tab order.
      tabIndex={-1}
      aria-selected={isHighlighted}
      data-test="mention-option"
      data-test-user-id={candidate.userId}
      className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1.5${isHighlighted ? ' bg-default-100' : ''}`}
      // WHY mousedown (not click): selecting must not blur the textarea — the
      // default mousedown behavior would move focus and kill the trigger.
      onMouseDown={(e) => {
        e.preventDefault()
        onSelect(candidate)
      }}
      onClick={(e) => e.preventDefault()}
    >
      <Avatar
        name={resolveDisplayName(candidate)}
        src={candidate.avatarUrl ?? undefined}
        size="sm"
        showFallback
        classNames={{ base: 'h-6 w-6 shrink-0', name: 'text-[10px]' }}
      />
      <span className="truncate text-sm text-foreground">{resolveDisplayName(candidate)}</span>
      {/* WHY always shown: usernames disambiguate duplicate display names (spec §9). */}
      <span className="ml-auto shrink-0 text-xs text-default-500">@{candidate.username}</span>
    </div>
  )
}

/**
 * Composer `@`-autocomplete popup. Pure UI — all state lives in
 * useMentionAutocomplete. Reuses the app's one popover pattern
 * (HeroUI Popover, same as EmojiPickerPopover).
 *
 * WHY an invisible trigger span (not the composer wrapper): PopoverTrigger
 * attaches press/toggle behavior to its child; wrapping the textarea would
 * turn every click into an open/close toggle. The zero-size span only anchors
 * the popover's position above the composer.
 */
export function MentionAutocomplete({
  isOpen,
  isLoading,
  results,
  highlightIndex,
  onSelect,
  onClose,
}: MentionAutocompleteProps) {
  const { t } = useTranslation('chat')

  return (
    <Popover
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (open === false) onClose()
      }}
      placement="top-start"
      shouldBlockScroll={false}
      updatePositionDeps={[results, isLoading]}
    >
      <PopoverTrigger>
        <span aria-hidden="true" className="absolute left-2 top-0 h-0 w-0" />
      </PopoverTrigger>
      <PopoverContent className="p-1">
        <div
          id="mention-listbox"
          role="listbox"
          aria-label={t('mentionPopupLabel')}
          data-test="mention-autocomplete"
          className="max-h-72 w-64 overflow-y-auto"
        >
          {isLoading && (
            <div data-test="mention-loading" className="flex justify-center px-2 py-2">
              <Spinner size="sm" />
            </div>
          )}
          {isLoading === false && results.length === 0 && (
            <div data-test="mention-no-results" className="px-2 py-1.5 text-sm text-default-500">
              {t('mentionNoResults')}
            </div>
          )}
          {isLoading === false &&
            results.map((candidate, index) => (
              <MentionOptionRow
                key={candidate.userId}
                candidate={candidate}
                isHighlighted={index === highlightIndex}
                onSelect={onSelect}
              />
            ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
