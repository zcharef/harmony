import { Avatar, Spinner } from '@heroui/react'
import { useEffect, useRef } from 'react'
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
 * useMentionAutocomplete.
 *
 * WHY a plain positioned listbox (not a HeroUI Popover): the popover renders a
 * react-aria dialog, which on open pulls focus onto the dialog container and
 * arms a FocusScope focus trap. That yanks focus off the composer textarea, so
 * the `@` query no longer types through — the user must click back in. This is
 * an aria-activedescendant combobox (the composer is the input, option rows are
 * `aria-activedescendant` targets), which is semantically NOT a dialog. A bare
 * absolutely-positioned `<div>` anchored inside the composer's `relative`
 * wrapper keeps focus in the textarea and the query types straight through.
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
  const containerRef = useRef<HTMLDivElement>(null)

  // WHY mousedown (not click): dismiss the popup when the user interacts
  // anywhere outside it — including clicking away in the textarea — mirroring
  // the old Popover's outside-press behavior. mousedown fires before the
  // textarea would blur, and option selection lives inside the container so it
  // is excluded here.
  useEffect(() => {
    if (isOpen === false) return
    const handlePointerDown = (event: MouseEvent) => {
      const container = containerRef.current
      const target = event.target
      if (container !== null && target instanceof Node && container.contains(target) === false) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [isOpen, onClose])

  if (isOpen === false) return null

  return (
    // WHY bottom-full: anchor above the composer (the old Popover used
    // placement="top-start"). The parent composer wrapper is `relative`.
    <div
      ref={containerRef}
      className="absolute bottom-full left-0 z-30 mb-1 rounded-large border border-default-200 bg-content1 p-1 shadow-medium"
    >
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
    </div>
  )
}
