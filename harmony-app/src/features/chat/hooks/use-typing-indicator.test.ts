import { act, renderHook } from '@testing-library/react'
import { vi } from 'vitest'
import { useTypingIndicator } from './use-typing-indicator'

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { access_token: 'test-token' } },
      }),
    },
  },
}))

vi.mock('@/lib/env', () => ({
  env: {
    VITE_API_URL: 'http://localhost:3000',
    VITE_SUPABASE_URL: 'http://localhost:54321',
    VITE_SUPABASE_ANON_KEY: 'test-anon-key',
  },
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

const CHANNEL_ID = 'channel-1'
const CURRENT_USER_ID = 'user-me'

// -- Helpers ------------------------------------------------------------------

/** Dispatches an sse:typing.started CustomEvent on window, mimicking useEventSource. */
function fireTypingSSE(detail: unknown) {
  window.dispatchEvent(new CustomEvent('sse:typing.started', { detail }))
}

// -- Tests --------------------------------------------------------------------

describe('useTypingIndicator', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
  })

  afterEach(() => {
    // Drain pending setTimeout callbacks to prevent cross-test bleed.
    act(() => {
      vi.runOnlyPendingTimers()
    })
    vi.useRealTimers()
  })

  // -- Empty params: no subscription -----------------------------------------

  it('does not add typing users when channelId is empty', () => {
    const { result } = renderHook(() => useTypingIndicator('', CURRENT_USER_ID))

    act(() => {
      fireTypingSSE({
        senderId: 'user-other',
        serverId: 'server-1',
        username: 'Alice',
        channelId: '',
      })
    })

    expect(result.current.typingUsers).toEqual([])
  })

  it('does not add typing users when currentUserId is empty', () => {
    const { result } = renderHook(() => useTypingIndicator(CHANNEL_ID, ''))

    act(() => {
      fireTypingSSE({
        senderId: 'user-other',
        serverId: 'server-1',
        username: 'Alice',
        channelId: CHANNEL_ID,
      })
    })

    expect(result.current.typingUsers).toEqual([])
  })

  // -- Typing event from other user adds to typingUsers ----------------------

  it('adds a remote user to typingUsers on valid SSE event', () => {
    const { result } = renderHook(() => useTypingIndicator(CHANNEL_ID, CURRENT_USER_ID))

    act(() => {
      fireTypingSSE({
        senderId: 'user-other',
        serverId: 'server-1',
        username: 'Alice',
        channelId: CHANNEL_ID,
      })
    })

    expect(result.current.typingUsers).toEqual([{ userId: 'user-other', username: 'Alice' }])
  })

  // -- Self-filtering: own events are ignored --------------------------------

  it('ignores typing events from the current user', () => {
    const { result } = renderHook(() => useTypingIndicator(CHANNEL_ID, CURRENT_USER_ID))

    act(() => {
      fireTypingSSE({
        senderId: CURRENT_USER_ID,
        serverId: 'server-1',
        username: 'Me',
        channelId: CHANNEL_ID,
      })
    })

    expect(result.current.typingUsers).toEqual([])
  })

  // -- Channel filtering: events for other channels are ignored --------------

  it('ignores typing events for a different channel', () => {
    const { result } = renderHook(() => useTypingIndicator(CHANNEL_ID, CURRENT_USER_ID))

    act(() => {
      fireTypingSSE({
        senderId: 'user-other',
        serverId: 'server-1',
        username: 'Alice',
        channelId: 'other-channel',
      })
    })

    expect(result.current.typingUsers).toEqual([])
  })

  // -- Malformed payload: silently ignored -----------------------------------

  it('ignores malformed typing payloads', () => {
    const { result } = renderHook(() => useTypingIndicator(CHANNEL_ID, CURRENT_USER_ID))

    act(() => {
      fireTypingSSE({ bad: 'data' })
    })

    act(() => {
      fireTypingSSE(null)
    })

    act(() => {
      fireTypingSSE(42)
    })

    expect(result.current.typingUsers).toEqual([])
  })

  // -- Deduplication: same user not added twice ------------------------------

  it('does not create duplicate entries for the same user', () => {
    const { result } = renderHook(() => useTypingIndicator(CHANNEL_ID, CURRENT_USER_ID))

    act(() => {
      fireTypingSSE({
        senderId: 'user-other',
        serverId: 'server-1',
        username: 'Alice',
        channelId: CHANNEL_ID,
      })
    })
    act(() => {
      fireTypingSSE({
        senderId: 'user-other',
        serverId: 'server-1',
        username: 'Alice',
        channelId: CHANNEL_ID,
      })
    })

    expect(result.current.typingUsers).toHaveLength(1)
    expect(result.current.typingUsers[0]?.userId).toBe('user-other')
  })

  // -- 5-second expiry: user removed after timeout ---------------------------

  it('removes a typing user after 5000ms', () => {
    const { result } = renderHook(() => useTypingIndicator(CHANNEL_ID, CURRENT_USER_ID))

    act(() => {
      fireTypingSSE({
        senderId: 'user-other',
        serverId: 'server-1',
        username: 'Alice',
        channelId: CHANNEL_ID,
      })
    })

    expect(result.current.typingUsers).toHaveLength(1)

    act(() => {
      vi.advanceTimersByTime(4999)
    })

    expect(result.current.typingUsers).toHaveLength(1)

    act(() => {
      vi.advanceTimersByTime(1)
    })

    expect(result.current.typingUsers).toHaveLength(0)
  })

  // -- 3-second throttle: sendTyping ignores rapid calls ---------------------

  it('throttles sendTyping to once per 3 seconds', async () => {
    const { result } = renderHook(() => useTypingIndicator(CHANNEL_ID, CURRENT_USER_ID))

    // First call goes through
    act(() => {
      result.current.sendTyping('Me')
    })

    // WHY: getAuthHeaders is async, so we must flush microtasks for fetch to be called.
    await act(async () => {
      await vi.runAllTimersAsync()
    })
    expect(globalThis.fetch).toHaveBeenCalledOnce()

    // Call within 3 seconds is throttled
    act(() => {
      vi.advanceTimersByTime(2999)
    })
    act(() => {
      result.current.sendTyping('Me')
    })
    await act(async () => {
      await vi.runAllTimersAsync()
    })
    expect(globalThis.fetch).toHaveBeenCalledOnce()

    // After 3 seconds, the next call goes through
    act(() => {
      vi.advanceTimersByTime(1)
    })
    act(() => {
      result.current.sendTyping('Me')
    })
    await act(async () => {
      await vi.runAllTimersAsync()
    })
    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
  })

  // -- sendTyping POSTs to correct endpoint ----------------------------------

  it('sends POST to correct typing endpoint', async () => {
    const { result } = renderHook(() => useTypingIndicator(CHANNEL_ID, CURRENT_USER_ID))

    act(() => {
      result.current.sendTyping('MyUsername')
    })

    await act(async () => {
      await vi.runAllTimersAsync()
    })

    expect(globalThis.fetch).toHaveBeenCalledWith(
      `http://localhost:3000/v1/channels/${CHANNEL_ID}/typing`,
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer test-token' },
      }),
    )
  })

  // -- Cleanup: event listener removed on unmount ----------------------------

  it('removes SSE event listener on unmount', () => {
    const removeListenerSpy = vi.spyOn(window, 'removeEventListener')

    const { unmount } = renderHook(() => useTypingIndicator(CHANNEL_ID, CURRENT_USER_ID))

    unmount()

    // WHY 'sse:typing.started': useServerEvent('typing.started', ...) prefixes
    // with SSE_EVENT_PREFIX ('sse:') → full event name is 'sse:typing.started'.
    expect(removeListenerSpy).toHaveBeenCalledWith('sse:typing.started', expect.any(Function))
    removeListenerSpy.mockRestore()
  })
})
