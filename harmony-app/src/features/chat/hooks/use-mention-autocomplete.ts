import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMembers } from '@/features/members'
import type { DmRecipientResponse, MemberResponse } from '@/lib/api'
import { listMembers } from '@/lib/api'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'

/**
 * Composer `@`-autocomplete state machine (mentions spec §1/§5.1, ticket §5 PR2).
 *
 * Owns: trigger detection, the two-mode data rule (client filter over the
 * cached member page when complete, debounced `?q=` server search when not),
 * ranking, the keyboard reducer, and the `username → member` map that the
 * send transform (`applyMentionMap`) consumes.
 */

/** Popup row shape — a projection of the generated MemberResponse (ADR-015: no hand-rolled API types). */
export type MentionCandidate = Pick<
  MemberResponse,
  'userId' | 'username' | 'displayName' | 'nickname' | 'avatarUrl'
>

/**
 * Structural subset of React.KeyboardEvent the reducer needs.
 * WHY: keeps the reducer testable without fabricating synthetic events.
 */
export interface MentionKeyEvent {
  key: string
  preventDefault: () => void
}

export interface MentionTrigger {
  /** Index of the `@` in the composer value. */
  start: number
  /** Text between the `@` and the caret (never contains whitespace). */
  query: string
}

/** Server-side cap on `?q=` (#80: longer is a 400; usernames cap at 32 anyway). */
const MENTION_QUERY_MAX_LENGTH = 32
const MAX_RESULTS = 8
const SEARCH_DEBOUNCE_MS = 200

/**
 * Detect an active mention trigger: `@` at start-of-input or after whitespace,
 * with the query running up to the caret. A query containing whitespace kills
 * the trigger (the mention token ended) — which also guarantees the server
 * search can never fire with a whitespace `q`.
 */
export function detectMentionTrigger(value: string, caret: number): MentionTrigger | null {
  const upToCaret = value.slice(0, caret)
  const atIndex = upToCaret.lastIndexOf('@')
  if (atIndex === -1) return null
  if (atIndex > 0) {
    const charBefore = upToCaret[atIndex - 1]
    if (charBefore !== undefined && /\s/.test(charBefore) === false) return null
  }
  const query = upToCaret.slice(atIndex + 1)
  if (/\s/.test(query)) return null
  if (query.length > MENTION_QUERY_MAX_LENGTH) return null
  return { start: atIndex, query }
}

/** 0 = prefix match, 1 = substring match, null = no match. */
function matchRank(candidate: MentionCandidate, query: string): 0 | 1 | null {
  let rank: 0 | 1 | null = null
  for (const field of [candidate.username, candidate.displayName, candidate.nickname]) {
    if (field === null || field === undefined) continue
    const haystack = field.toLowerCase()
    if (haystack.startsWith(query)) return 0
    if (haystack.includes(query)) rank = 1
  }
  return rank
}

/**
 * Rank candidates for the popup: prefix matches before substring matches
 * across username/displayName/nickname (case-insensitive), stable within a
 * rank tier, capped at 8 rows (spec §1).
 */
export function rankMentionCandidates(
  candidates: MentionCandidate[],
  query: string,
): MentionCandidate[] {
  if (query.length === 0) return candidates.slice(0, MAX_RESULTS)
  const q = query.toLowerCase()
  const prefix: MentionCandidate[] = []
  const substring: MentionCandidate[] = []
  for (const candidate of candidates) {
    const rank = matchRank(candidate, q)
    if (rank === 0) prefix.push(candidate)
    else if (rank === 1) substring.push(candidate)
  }
  return [...prefix, ...substring].slice(0, MAX_RESULTS)
}

/** The single popup row for a DM: the recipient (spec §1 — no members query in DMs). */
function dmCandidates(dmRecipient: DmRecipientResponse | null, query: string): MentionCandidate[] {
  if (dmRecipient === null) return []
  const recipient: MentionCandidate = {
    userId: dmRecipient.id,
    username: dmRecipient.username,
    displayName: dmRecipient.displayName ?? null,
    nickname: null,
    avatarUrl: dmRecipient.avatarUrl ?? null,
  }
  return rankMentionCandidates([recipient], query)
}

/**
 * Merge the (possibly partial) cached page with server search results,
 * dedupe by userId, then rank (spec §1 two-mode rule).
 */
function mergeAndRank(
  cached: MentionCandidate[],
  searched: MentionCandidate[],
  query: string,
): MentionCandidate[] {
  const merged: MentionCandidate[] = []
  const seen = new Set<string>()
  for (const member of [...cached, ...searched]) {
    if (seen.has(member.userId)) continue
    seen.add(member.userId)
    merged.push(member)
  }
  return rankMentionCandidates(merged, query)
}

type MentionKeyAction = 'dismiss' | 'down' | 'up' | 'insert' | null

/**
 * WHY null on empty results for everything but Escape: the "No members found"
 * row must not block sending — Enter falls through (spec §1 empty state).
 */
function keyToAction(key: string, resultCount: number): MentionKeyAction {
  if (key === 'Escape') return 'dismiss'
  if (resultCount === 0) return null
  if (key === 'ArrowDown') return 'down'
  if (key === 'ArrowUp') return 'up'
  if (key === 'Enter' || key === 'Tab') return 'insert'
  return null
}

interface UseMentionAutocompleteOptions {
  serverId: string | null
  isDm: boolean
  /** WHY: DMs mount no members query — the popup is exactly this one row (spec §1). */
  dmRecipient: DmRecipientResponse | null
  /** Controlled composer value. */
  value: string
  onValueChange: (value: string) => void
  /** WHY: caret position (trigger detection, insertion) lives on the DOM node. */
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
}

export function useMentionAutocomplete({
  serverId,
  isDm,
  dmRecipient,
  value,
  onValueChange,
  textareaRef,
}: UseMentionAutocompleteOptions) {
  const [trigger, setTrigger] = useState<MentionTrigger | null>(null)
  const [isDismissed, setIsDismissed] = useState(false)
  const [highlightIndex, setHighlightIndex] = useState(0)
  /**
   * username → member objects for every popup insertion. The send transform
   * resolves `@username` tokens through it (only inserted mentions convert —
   * hand-typed names stay plain text, spec §9). Ref (not state): it never
   * drives a render, and it must survive send failures so a resend still
   * carries the mentions (spec §6.1) — which is also WHY it is never cleared
   * on send: entries outlive the message that inserted them, so a hand-typed
   * `@username` of a PREVIOUSLY popup-inserted user still converts. Accepted:
   * usernames are globally unique and immutable, so the mapping can never
   * point at the wrong user. Entries never collide across channels either.
   */
  const mentionMapRef = useRef<Record<string, MentionCandidate>>({})

  // WHY effect (not derived): the caret lives outside React state. Reading it
  // after the controlled value lands keeps trigger detection cursor-accurate.
  useEffect(() => {
    const caret = textareaRef.current?.selectionStart ?? value.length
    setTrigger(detectMentionTrigger(value, caret))
  }, [value, textareaRef])

  const activeQuery = trigger === null ? null : trigger.query

  // WHY reset here: an Esc-dismissal holds only until the query changes —
  // typing another character re-opens the popup (Discord behavior).
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeQuery is the trigger-change signal
  useEffect(() => {
    setIsDismissed(false)
    setHighlightIndex(0)
  }, [activeQuery])

  // WHY gate on the trigger: no member fetch before the user actually types
  // `@` — passing null keeps useMembers disabled (its own `enabled` guard).
  const isMembersEnabled = isDm === false && serverId !== null && trigger !== null
  const membersQuery = useMembers(isMembersEnabled ? serverId : null)
  const membersPage = membersQuery.data
  // WHY: nextCursor != null means the cached first page is structurally
  // incomplete — the two-mode rule switches to the `?q=` server search.
  const isCacheIncomplete =
    membersPage !== undefined &&
    membersPage.nextCursor !== null &&
    membersPage.nextCursor !== undefined

  const [debouncedQuery, setDebouncedQuery] = useState('')
  useEffect(() => {
    if (activeQuery === null || activeQuery.length === 0) {
      setDebouncedQuery('')
      return
    }
    const id = setTimeout(() => setDebouncedQuery(activeQuery), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [activeQuery])

  // WHY the guard chain (#80 backend rules): NEVER an empty/whitespace `q`
  // (400), max 32 chars, and `q` is never combined with `before`.
  const isSearchEnabled =
    isMembersEnabled &&
    isCacheIncomplete &&
    debouncedQuery.trim().length >= 1 &&
    debouncedQuery.length <= MENTION_QUERY_MAX_LENGTH
  const searchQuery = useQuery({
    queryKey: queryKeys.servers.memberSearch(serverId ?? '', debouncedQuery),
    queryFn: async () => {
      // WHY: `enabled` guard ensures serverId is non-null when queryFn runs
      if (serverId === null) throw new Error('serverId is required')
      const { data } = await listMembers({
        path: { id: serverId },
        query: { q: debouncedQuery },
        throwOnError: true,
      })
      return data
    },
    enabled: isSearchEnabled,
  })

  // ADR-028: autocomplete data failure is a background failure — the popup
  // simply does not open. Breadcrumb only, never a toast.
  const isMembersError = membersQuery.isError
  const isSearchError = searchQuery.isError
  useEffect(() => {
    if (isMembersError === true || isSearchError === true) {
      logger.warn('mention_autocomplete_fetch_failed', {
        serverId,
        source: isMembersError === true ? 'members' : 'search',
      })
    }
  }, [isMembersError, isSearchError, serverId])

  const searchItems = searchQuery.data?.items
  const results = useMemo<MentionCandidate[]>(() => {
    if (trigger === null) return []
    if (isDm) return dmCandidates(dmRecipient, trigger.query)
    return mergeAndRank(
      membersPage?.items ?? [],
      isCacheIncomplete ? (searchItems ?? []) : [],
      trigger.query,
    )
  }, [trigger, isDm, dmRecipient, membersPage, isCacheIncomplete, searchItems])

  const hasError = isMembersError === true || isSearchError === true
  const isOpen =
    trigger !== null &&
    isDismissed === false &&
    hasError === false &&
    (isDm ? dmRecipient !== null : serverId !== null)

  // Spinner row: cold members cache, or server search in flight with no
  // partial results to show (spec §1 loading state).
  const isLoading =
    isOpen &&
    isDm === false &&
    ((isMembersEnabled && membersQuery.isPending) ||
      (isSearchEnabled && searchQuery.isPending && results.length === 0))

  // WHY clamp: results shrink as the query narrows; the highlight must never
  // point past the last row.
  const boundedHighlight = results.length === 0 ? 0 : Math.min(highlightIndex, results.length - 1)

  const insertMention = useCallback(
    (candidate: MentionCandidate) => {
      if (trigger === null) return
      mentionMapRef.current[candidate.username] = candidate
      const caret = textareaRef.current?.selectionStart ?? value.length
      const inserted = `@${candidate.username} `
      const next = value.slice(0, trigger.start) + inserted + value.slice(caret)
      onValueChange(next)
      const nextCaret = trigger.start + inserted.length
      // WHY rAF: the controlled value reaches the DOM only after React
      // re-renders; the caret can only be placed after that.
      requestAnimationFrame(() => {
        const textarea = textareaRef.current
        if (textarea !== null) {
          textarea.focus()
          textarea.setSelectionRange(nextCaret, nextCaret)
        }
      })
    },
    [trigger, value, onValueChange, textareaRef],
  )

  const close = useCallback(() => {
    setIsDismissed(true)
  }, [])

  /**
   * Keyboard reducer. Returns true when the event was consumed — the caller
   * MUST NOT run its own handling (Enter-to-send) in that case.
   */
  const handleKeyDown = useCallback(
    (e: MentionKeyEvent): boolean => {
      if (isOpen === false) return false
      const action = keyToAction(e.key, results.length)
      if (action === null) return false
      e.preventDefault()
      if (action === 'dismiss') {
        setIsDismissed(true)
      } else if (action === 'down') {
        setHighlightIndex((boundedHighlight + 1) % results.length)
      } else if (action === 'up') {
        setHighlightIndex((boundedHighlight - 1 + results.length) % results.length)
      } else {
        const candidate = results[boundedHighlight]
        if (candidate !== undefined) insertMention(candidate)
      }
      return true
    },
    [isOpen, results, boundedHighlight, insertMention],
  )

  return {
    isOpen,
    isLoading,
    results,
    highlightIndex: boundedHighlight,
    handleKeyDown,
    insertMention,
    close,
    mentionMapRef,
  }
}

export type UseMentionAutocompleteResult = ReturnType<typeof useMentionAutocomplete>
