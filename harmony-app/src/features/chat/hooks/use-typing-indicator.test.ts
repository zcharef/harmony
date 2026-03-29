import { act, renderHook } from '@testing-library/react'
import { vi } from 'vitest'
import { sendTyping as sendTypingApi } from '@/lib/api'
import { useTypingIndicator } from './use-typing-indicator'

vi.mock('@/lib/api', () => ({
  sendTyping: vi.fn().mockResolvedValue({ data: undefined }),
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

  // -- Timer reset: repeated events extend the expiry window ----------------

  it('resets the 5s expiry timer when the same user sends another typing event', () => {
    const { result } = renderHook(() => useTypingIndicator(CHANNEL_ID, CURRENT_USER_ID))

    act(() => {
      fireTypingSSE({
        senderId: 'user-other',
        serverId: 'server-1',
        username: 'Alice',
        channelId: CHANNEL_ID,
      })
    })

    // Advance 3s, then send another typing event (timer should restart)
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    act(() => {
      fireTypingSSE({
        senderId: 'user-other',
        serverId: 'server-1',
        username: 'Alice',
        channelId: CHANNEL_ID,
      })
    })

    // 4s after the second event — the old timer (5s from first event) would
    // have fired at 5s total, but the reset timer keeps the user alive.
    act(() => {
      vi.advanceTimersByTime(4000)
    })
    expect(result.current.typingUsers).toHaveLength(1)

    // 5s after the second event — now the user expires
    act(() => {
      vi.advanceTimersByTime(1000)
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

    await act(async () => {
      await vi.runAllTimersAsync()
    })
    expect(sendTypingApi).toHaveBeenCalledOnce()

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
    expect(sendTypingApi).toHaveBeenCalledOnce()

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
    expect(sendTypingApi).toHaveBeenCalledTimes(2)
  })

  // -- sendTyping calls SDK with correct params --------------------------------

  it('calls SDK sendTyping with correct channel ID', async () => {
    const { result } = renderHook(() => useTypingIndicator(CHANNEL_ID, CURRENT_USER_ID))

    act(() => {
      result.current.sendTyping('MyUsername')
    })

    await act(async () => {
      await vi.runAllTimersAsync()
    })

    expect(sendTypingApi).toHaveBeenCalledWith({
      path: { id: CHANNEL_ID },
      throwOnError: true,
    })
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
