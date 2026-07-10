import { act, renderHook, waitFor } from '@testing-library/react'
import { vi } from 'vitest'
import type { DmRecipientResponse, MemberListResponse, MemberResponse } from '@/lib/api'
import { createQueryWrapper, createTestQueryClient } from '@/tests/test-utils'
import type { MentionCandidate, MentionKeyEvent } from './use-mention-autocomplete'
import {
  detectMentionTrigger,
  rankMentionCandidates,
  useMentionAutocomplete,
} from './use-mention-autocomplete'

vi.mock('@/lib/api', () => ({
  listMembers: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const { listMembers } = await import('@/lib/api')
const { logger } = await import('@/lib/logger')

const SERVER_ID = 'server-1'

function buildMember(overrides: Partial<MemberResponse> = {}): MemberResponse {
  return {
    userId: 'user-alice',
    username: 'alice',
    displayName: 'Alice',
    nickname: null,
    avatarUrl: null,
    role: 'member',
    joinedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function buildPage(items: MemberResponse[], nextCursor: string | null = null): MemberListResponse {
  return { items, nextCursor }
}

function keyEvent(key: string): MentionKeyEvent {
  return { key, preventDefault: () => {} }
}

function setup(
  options: {
    serverId?: string | null
    isDm?: boolean
    dmRecipient?: DmRecipientResponse | null
  } = {},
) {
  const textarea = document.createElement('textarea')
  const textareaRef = { current: textarea }
  const onValueChange = vi.fn()
  const queryClient = createTestQueryClient()
  const wrapper = createQueryWrapper(queryClient)

  const utils = renderHook(
    ({ value }: { value: string }) =>
      useMentionAutocomplete({
        serverId: options.serverId !== undefined ? options.serverId : SERVER_ID,
        isDm: options.isDm ?? false,
        dmRecipient: options.dmRecipient ?? null,
        value,
        onValueChange,
        textareaRef,
      }),
    { wrapper, initialProps: { value: '' } },
  )

  /** Simulates typing: syncs the DOM textarea (caret source) then rerenders. */
  function type(value: string, caret: number = value.length) {
    textarea.value = value
    textarea.selectionStart = caret
    textarea.selectionEnd = caret
    utils.rerender({ value })
  }

  return { ...utils, type, onValueChange, textarea }
}

/** Every recorded listMembers call that carried a `q` search param. */
function searchCalls() {
  return vi.mocked(listMembers).mock.calls.filter((call) => call[0]?.query?.q !== undefined)
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ── detectMentionTrigger (pure) ───────────────────────────────────────

describe('detectMentionTrigger', () => {
  it('triggers on @ at start-of-input', () => {
    expect(detectMentionTrigger('@al', 3)).toEqual({ start: 0, query: 'al' })
  })

  it('triggers on @ after whitespace', () => {
    expect(detectMentionTrigger('hey @bo', 7)).toEqual({ start: 4, query: 'bo' })
  })

  it('does NOT trigger mid-word (bob@alice)', () => {
    expect(detectMentionTrigger('bob@alice', 9)).toBeNull()
  })

  it('dies when the query contains whitespace (token ended)', () => {
    expect(detectMentionTrigger('@al ice', 7)).toBeNull()
  })

  it('respects the caret position (text after the caret is ignored)', () => {
    expect(detectMentionTrigger('@al rest', 3)).toEqual({ start: 0, query: 'al' })
  })

  it('returns null with no @ before the caret', () => {
    expect(detectMentionTrigger('hello', 5)).toBeNull()
  })

  it('returns null when the query exceeds 32 chars (server q cap)', () => {
    const long = `@${'a'.repeat(33)}`
    expect(detectMentionTrigger(long, long.length)).toBeNull()
  })
})

// ── rankMentionCandidates (pure) ──────────────────────────────────────

describe('rankMentionCandidates', () => {
  const candidates: MentionCandidate[] = [
    {
      userId: 'u1',
      username: 'zed',
      displayName: 'has al inside: malzahar',
      nickname: null,
      avatarUrl: null,
    },
    { userId: 'u2', username: 'alice', displayName: 'Wonder', nickname: null, avatarUrl: null },
    { userId: 'u3', username: 'bob', displayName: 'Alina', nickname: null, avatarUrl: null },
    { userId: 'u4', username: 'carol', displayName: null, nickname: 'ALbert', avatarUrl: null },
    { userId: 'u5', username: 'dave', displayName: 'Dave', nickname: null, avatarUrl: null },
  ]

  it('ranks prefix matches before substring matches, across username/displayName/nickname', () => {
    const ranked = rankMentionCandidates(candidates, 'al')
    expect(ranked.map((c) => c.userId)).toEqual(['u2', 'u3', 'u4', 'u1'])
  })

  it('matches case-insensitively', () => {
    const ranked = rankMentionCandidates(candidates, 'AL')
    expect(ranked.map((c) => c.userId)).toEqual(['u2', 'u3', 'u4', 'u1'])
  })

  it('drops non-matching candidates', () => {
    expect(rankMentionCandidates(candidates, 'zzz')).toEqual([])
  })

  it('returns the first 8 candidates unfiltered for an empty query', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      userId: `u${i}`,
      username: `user${i}`,
      displayName: null,
      nickname: null,
      avatarUrl: null,
    }))
    expect(rankMentionCandidates(many, '')).toHaveLength(8)
  })

  it('keeps duplicate display names as distinct rows (disambiguated by userId/username)', () => {
    const twins: MentionCandidate[] = [
      { userId: 'u-a', username: 'alice_a', displayName: 'Alice', nickname: null, avatarUrl: null },
      { userId: 'u-b', username: 'alice_b', displayName: 'Alice', nickname: null, avatarUrl: null },
    ]
    const ranked = rankMentionCandidates(twins, 'alice')
    expect(ranked.map((c) => c.username)).toEqual(['alice_a', 'alice_b'])
  })
})

// ── two-mode data rule ────────────────────────────────────────────────

describe('useMentionAutocomplete — two-mode data rule', () => {
  it('client-filters a complete cached page and NEVER fires the q search', async () => {
    vi.mocked(listMembers).mockResolvedValue({
      data: buildPage([
        buildMember(),
        buildMember({ userId: 'user-bob', username: 'bob', displayName: 'Bob' }),
      ]),
    } as never)

    const { result, type } = setup()
    act(() => type('@al'))

    await waitFor(() => expect(result.current.results).toHaveLength(1))
    expect(result.current.results[0]?.username).toBe('alice')
    expect(result.current.isOpen).toBe(true)

    // Debounce window fully elapsed — still no ?q= request (complete cache).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300))
    })
    expect(searchCalls()).toHaveLength(0)
  })

  it('fires the debounced q search on an incomplete cache and merges/dedupes by userId', async () => {
    vi.mocked(listMembers).mockImplementation(async (opts) => {
      const hasQ = opts?.query?.q !== undefined
      if (hasQ) {
        return {
          data: buildPage([
            // Duplicate of the cached alice — must dedupe by userId.
            buildMember(),
            buildMember({ userId: 'user-alan', username: 'alan', displayName: 'Alan' }),
          ]),
        } as never
      }
      return { data: buildPage([buildMember()], 'cursor-next') } as never
    })

    const { result, type } = setup()
    act(() => type('@al'))

    // Partial (cached) result renders immediately.
    await waitFor(() => expect(result.current.results).toHaveLength(1))

    // After the 200ms debounce, the server search fires with q.
    await waitFor(() => expect(searchCalls()).toHaveLength(1), { timeout: 2000 })
    expect(listMembers).toHaveBeenCalledWith({
      path: { id: SERVER_ID },
      query: { q: 'al' },
      throwOnError: true,
    })

    await waitFor(() => expect(result.current.results).toHaveLength(2))
    expect(result.current.results.map((c) => c.userId)).toEqual(['user-alice', 'user-alan'])
  })

  it('never sends an empty or whitespace q (#80: empty q is a 400)', async () => {
    vi.mocked(listMembers).mockResolvedValue({
      data: buildPage([buildMember()], 'cursor-next'),
    } as never)

    const { result, type } = setup()
    // Bare "@" — popup opens (unfiltered list) but q search must NOT fire.
    act(() => type('@'))
    await waitFor(() => expect(result.current.isOpen).toBe(true))

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300))
    })
    expect(searchCalls()).toHaveLength(0)

    // "@ " — whitespace kills the trigger entirely: popup closed, no request.
    act(() => type('@ '))
    expect(result.current.isOpen).toBe(false)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300))
    })
    expect(searchCalls()).toHaveLength(0)
  })

  it('does not fetch members at all before an @ trigger exists', async () => {
    vi.mocked(listMembers).mockResolvedValue({ data: buildPage([buildMember()]) } as never)

    const { result, type } = setup()
    act(() => type('hello world'))

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(listMembers).not.toHaveBeenCalled()
    expect(result.current.isOpen).toBe(false)
  })
})

// ── state matrix ──────────────────────────────────────────────────────

describe('useMentionAutocomplete — state matrix', () => {
  it('error: popup does NOT open and a warn breadcrumb is logged (ADR-028, no toast)', async () => {
    vi.mocked(listMembers).mockRejectedValue(new Error('network down'))

    const { result, type } = setup()
    act(() => type('@al'))

    await waitFor(() => expect(logger.warn).toHaveBeenCalled())
    expect(logger.warn).toHaveBeenCalledWith('mention_autocomplete_fetch_failed', {
      serverId: SERVER_ID,
      source: 'members',
    })
    expect(result.current.isOpen).toBe(false)
  })

  it('loading: open with isLoading while the members cache is cold', async () => {
    let resolveMembers!: (value: unknown) => void
    vi.mocked(listMembers).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveMembers = resolve
        }) as never,
    )

    const { result, type } = setup()
    act(() => type('@al'))

    await waitFor(() => expect(result.current.isOpen).toBe(true))
    expect(result.current.isLoading).toBe(true)
    expect(result.current.results).toEqual([])

    await act(async () => {
      resolveMembers({ data: buildPage([buildMember()]) })
    })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.results).toHaveLength(1)
  })

  it('empty: open with zero results when the query matches nobody', async () => {
    vi.mocked(listMembers).mockResolvedValue({ data: buildPage([buildMember()]) } as never)

    const { result, type } = setup()
    act(() => type('@zzz'))

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.isOpen).toBe(true)
    expect(result.current.results).toEqual([])
  })

  it('DM: exactly one recipient row, and no members request ever fires', async () => {
    const recipient: DmRecipientResponse = {
      id: 'user-dm',
      username: 'dmfriend',
      displayName: 'DM Friend',
      avatarUrl: null,
    }
    const { result, type } = setup({ serverId: null, isDm: true, dmRecipient: recipient })
    act(() => type('@dm'))

    await waitFor(() => expect(result.current.isOpen).toBe(true))
    expect(result.current.results).toEqual([
      {
        userId: 'user-dm',
        username: 'dmfriend',
        displayName: 'DM Friend',
        nickname: null,
        avatarUrl: null,
      },
    ])
    expect(listMembers).not.toHaveBeenCalled()
  })
})

// ── keyboard reducer ──────────────────────────────────────────────────

describe('useMentionAutocomplete — keyboard reducer', () => {
  async function openWithMembers(members: MemberResponse[]) {
    vi.mocked(listMembers).mockResolvedValue({ data: buildPage(members) } as never)
    const utils = setup()
    act(() => utils.type('@'))
    await waitFor(() => expect(utils.result.current.results).toHaveLength(members.length))
    return utils
  }

  const TWO_MEMBERS = [
    buildMember(),
    buildMember({ userId: 'user-bob', username: 'bob', displayName: 'Bob' }),
  ]

  it('ArrowDown/ArrowUp move the highlight and wrap around', async () => {
    const { result } = await openWithMembers(TWO_MEMBERS)
    expect(result.current.highlightIndex).toBe(0)

    act(() => {
      expect(result.current.handleKeyDown(keyEvent('ArrowDown'))).toBe(true)
    })
    expect(result.current.highlightIndex).toBe(1)

    act(() => {
      expect(result.current.handleKeyDown(keyEvent('ArrowDown'))).toBe(true)
    })
    expect(result.current.highlightIndex).toBe(0)

    act(() => {
      expect(result.current.handleKeyDown(keyEvent('ArrowUp'))).toBe(true)
    })
    expect(result.current.highlightIndex).toBe(1)
  })

  it('Enter while open consumes the event and inserts @username with a trailing space', async () => {
    const { result, onValueChange } = await openWithMembers(TWO_MEMBERS)

    let consumed = false
    act(() => {
      consumed = result.current.handleKeyDown(keyEvent('Enter'))
    })
    expect(consumed).toBe(true)
    expect(onValueChange).toHaveBeenCalledWith('@alice ')
    // The inserted member is recorded in the map for the send transform.
    expect(result.current.mentionMapRef.current.get('alice')?.userId).toBe('user-alice')
  })

  it('inserting a __proto__ username stores plain map data (no prototype mutation)', async () => {
    const { result } = await openWithMembers([
      buildMember({ userId: 'user-proto', username: '__proto__', displayName: 'Proto' }),
    ])

    act(() => {
      result.current.handleKeyDown(keyEvent('Enter'))
    })

    expect(result.current.mentionMapRef.current.get('__proto__')?.userId).toBe('user-proto')
    expect(Object.getPrototypeOf(result.current.mentionMapRef.current)).toBe(Map.prototype)
  })

  it('Tab inserts like Enter', async () => {
    const { result, onValueChange } = await openWithMembers(TWO_MEMBERS)
    act(() => {
      expect(result.current.handleKeyDown(keyEvent('Tab'))).toBe(true)
    })
    expect(onValueChange).toHaveBeenCalledWith('@alice ')
  })

  it('Escape closes the popup and consumes the event', async () => {
    const { result } = await openWithMembers(TWO_MEMBERS)
    act(() => {
      expect(result.current.handleKeyDown(keyEvent('Escape'))).toBe(true)
    })
    expect(result.current.isOpen).toBe(false)
  })

  it('Enter falls through to send when the popup shows "No members found"', async () => {
    vi.mocked(listMembers).mockResolvedValue({ data: buildPage([buildMember()]) } as never)
    const { result, type } = setup()
    act(() => type('@zzz'))
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.isOpen).toBe(true)

    let consumed = true
    act(() => {
      consumed = result.current.handleKeyDown(keyEvent('Enter'))
    })
    expect(consumed).toBe(false)
  })

  it('does nothing when the popup is closed', () => {
    const { result } = setup()
    expect(result.current.handleKeyDown(keyEvent('Enter'))).toBe(false)
    expect(result.current.handleKeyDown(keyEvent('ArrowDown'))).toBe(false)
  })

  it('typing after an Escape dismissal re-opens the popup', async () => {
    const { result, type } = await openWithMembers(TWO_MEMBERS)
    act(() => {
      result.current.handleKeyDown(keyEvent('Escape'))
    })
    expect(result.current.isOpen).toBe(false)

    act(() => type('@a'))
    await waitFor(() => expect(result.current.isOpen).toBe(true))
  })

  it('insertMention replaces the @query up to the caret, preserving surrounding text', async () => {
    vi.mocked(listMembers).mockResolvedValue({ data: buildPage(TWO_MEMBERS) } as never)
    const { result, type, onValueChange } = setup()
    act(() => type('hey @al rest', 7))
    await waitFor(() => expect(result.current.results).toHaveLength(1))

    const candidate = result.current.results[0]
    if (candidate === undefined) throw new Error('expected a candidate')
    act(() => {
      result.current.insertMention(candidate)
    })
    expect(onValueChange).toHaveBeenCalledWith('hey @alice  rest')
  })
})
