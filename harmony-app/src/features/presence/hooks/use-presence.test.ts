import { renderHook } from '@testing-library/react'
import { act } from 'react'
import { vi } from 'vitest'
import type { UserPreferencesResponse } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { createQueryWrapper, createTestQueryClient } from '@/tests/test-utils'
import { usePresenceStore } from '../stores/presence-store'
import { usePresence } from './use-presence'

vi.mock('@/lib/api', () => ({
  getPreferences: vi.fn(),
  updatePresence: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

// WHY mock the voice barrel: usePresence only reads `status === 'connected'`.
// Importing the real barrel would pull livekit-client into this test for one
// boolean. A minimal zustand-shaped stub keeps the test focused on presence.
vi.mock('@/features/voice', () => {
  const state = { status: 'idle' }
  const useVoiceConnectionStore = (selector: (s: typeof state) => unknown) => selector(state)
  useVoiceConnectionStore.getState = () => state
  return { useVoiceConnectionStore }
})

const { getPreferences, updatePresence } = await import('@/lib/api')

const USER_ID = 'user-me'
const IDLE_TIMEOUT_MS = 300_000

// -- Helpers -------------------------------------------------------------------

const initialPresenceState = usePresenceStore.getState()

function buildPreferences(
  overrides: Partial<UserPreferencesResponse> = {},
): UserPreferencesResponse {
  return {
    dndEnabled: false,
    hideProfanity: true,
    onboardingCompleted: false,
    updatedAt: '2026-04-02T00:00:00.000Z',
    ...overrides,
  }
}

function renderPresence(options: {
  preferences?: UserPreferencesResponse
  userId?: string | null
}) {
  const queryClient = createTestQueryClient()
  if (options.preferences !== undefined) {
    queryClient.setQueryData(queryKeys.preferences.me(), options.preferences)
  }

  // WHY explicit undefined check: `null` is a meaningful value here (logged
  // out) — `??` would silently replace it with USER_ID.
  const userId = options.userId === undefined ? USER_ID : options.userId
  const rendered = renderHook(() => usePresence(userId), {
    wrapper: createQueryWrapper(queryClient),
  })

  return { queryClient, ...rendered }
}

function postedStatuses(): string[] {
  return vi
    .mocked(updatePresence)
    .mock.calls.map((call) => (call[0] as { body: { status: string } }).body.status)
}

// -- Tests ---------------------------------------------------------------------

describe('usePresence — DND integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    usePresenceStore.setState(initialPresenceState, true)
    vi.mocked(updatePresence).mockResolvedValue({} as never)
    // WHY: The preferences query must never resolve on its own — the seeded
    // cache is the single source of truth for dndEnabled in each scenario.
    vi.mocked(getPreferences).mockReturnValue(new Promise(() => {}) as never)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // -- DND ON: presence locked to 'dnd' (user-preferences-dnd 6.3/6.6) ---------

  it('posts and stores "dnd" when DND is enabled', () => {
    renderPresence({ preferences: buildPreferences({ dndEnabled: true }) })

    expect(postedStatuses()).toEqual(['dnd'])
    expect(usePresenceStore.getState().presenceMap.get(USER_ID)).toBe('dnd')
  })

  it('does not auto-idle while DND is enabled (idle interval is a no-op)', () => {
    renderPresence({ preferences: buildPreferences({ dndEnabled: true }) })

    act(() => {
      vi.advanceTimersByTime(IDLE_TIMEOUT_MS + 60_000)
    })

    expect(postedStatuses()).toEqual(['dnd'])
    expect(usePresenceStore.getState().presenceMap.get(USER_ID)).toBe('dnd')
  })

  // -- DND OFF: status restored based on real activity (6.7) --------------------

  it('posts and stores "online" when DND is disabled and the user is active', () => {
    renderPresence({ preferences: buildPreferences({ dndEnabled: false }) })

    expect(postedStatuses()).toEqual(['online'])
    expect(usePresenceStore.getState().presenceMap.get(USER_ID)).toBe('online')
  })

  it('restores "online" when DND is toggled off with recent activity', () => {
    const { queryClient } = renderPresence({
      preferences: buildPreferences({ dndEnabled: true }),
    })
    expect(postedStatuses()).toEqual(['dnd'])

    // WHY advanceTimersByTime(1): TanStack Query v5 notifies observers via a
    // setTimeout(0) macrotask — under fake timers it must be fired explicitly
    // so the re-render carrying dndEnabled=false lands before assertions.
    act(() => {
      queryClient.setQueryData(queryKeys.preferences.me(), buildPreferences({ dndEnabled: false }))
    })
    act(() => {
      vi.advanceTimersByTime(1)
    })

    expect(postedStatuses()).toEqual(['dnd', 'online'])
    expect(usePresenceStore.getState().presenceMap.get(USER_ID)).toBe('online')
  })

  it('restores "idle" (not "online") when DND is toggled off after being AFK', () => {
    const { queryClient } = renderPresence({
      preferences: buildPreferences({ dndEnabled: true }),
    })
    expect(postedStatuses()).toEqual(['dnd'])

    // AFK: no activity events for longer than the idle timeout.
    act(() => {
      vi.advanceTimersByTime(IDLE_TIMEOUT_MS + 60_000)
    })

    act(() => {
      queryClient.setQueryData(queryKeys.preferences.me(), buildPreferences({ dndEnabled: false }))
    })
    act(() => {
      vi.advanceTimersByTime(1)
    })

    expect(postedStatuses()).toEqual(['dnd', 'idle'])
    expect(usePresenceStore.getState().presenceMap.get(USER_ID)).toBe('idle')
  })

  it('transitions to "idle" after the idle timeout when DND is off', () => {
    renderPresence({ preferences: buildPreferences({ dndEnabled: false }) })
    expect(postedStatuses()).toEqual(['online'])

    act(() => {
      vi.advanceTimersByTime(IDLE_TIMEOUT_MS + 60_000)
    })

    expect(postedStatuses()).toEqual(['online', 'idle'])
    expect(usePresenceStore.getState().presenceMap.get(USER_ID)).toBe('idle')
  })

  it('returns to "online" on activity after idle (DND off)', () => {
    renderPresence({ preferences: buildPreferences({ dndEnabled: false }) })

    act(() => {
      vi.advanceTimersByTime(IDLE_TIMEOUT_MS + 60_000)
    })
    expect(postedStatuses()).toEqual(['online', 'idle'])

    act(() => {
      window.dispatchEvent(new Event('keydown'))
    })

    expect(postedStatuses()).toEqual(['online', 'idle', 'online'])
  })

  it('keeps status locked to "dnd" on activity while DND is enabled', () => {
    renderPresence({ preferences: buildPreferences({ dndEnabled: true }) })

    act(() => {
      window.dispatchEvent(new Event('mousemove'))
      window.dispatchEvent(new Event('keydown'))
    })

    expect(postedStatuses()).toEqual(['dnd'])
  })

  // -- Loading gate --------------------------------------------------------------

  it('posts nothing while the preferences query is still pending', () => {
    // No seeded cache: usePreferences().isPending === true.
    renderPresence({})

    act(() => {
      vi.advanceTimersByTime(60_000)
    })

    expect(updatePresence).not.toHaveBeenCalled()
    expect(usePresenceStore.getState().presenceMap.size).toBe(0)
  })

  it('posts nothing when logged out (userId null)', () => {
    renderPresence({ preferences: buildPreferences(), userId: null })

    expect(updatePresence).not.toHaveBeenCalled()
  })

  // -- Logout cleanup -------------------------------------------------------------

  it('removes the user from the presence store on unmount (logout)', () => {
    const { unmount } = renderPresence({ preferences: buildPreferences() })
    expect(usePresenceStore.getState().presenceMap.get(USER_ID)).toBe('online')

    unmount()

    expect(usePresenceStore.getState().presenceMap.has(USER_ID)).toBe(false)
  })
})
