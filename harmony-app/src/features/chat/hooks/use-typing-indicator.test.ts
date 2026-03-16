import { vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useTypingIndicator } from './use-typing-indicator'

vi.mock('@/lib/supabase', () => ({
  supabase: {
    channel: vi.fn(),
    removeChannel: vi.fn(),
  },
}))

const { supabase } = await import('@/lib/supabase')

const CHANNEL_ID = 'channel-1'
const CURRENT_USER_ID = 'user-me'

// -- Helpers ------------------------------------------------------------------

/**
 * Creates a mock Supabase Broadcast channel that captures the typing handler
 * and exposes `.send()` as a spy for outgoing broadcast assertions.
 */
function createMockChannel() {
  let broadcastHandler: Function | null = null
  const channel = {
    on: vi.fn((type: string, filter: { event: string }, callback: Function) => {
      if (type === 'broadcast' && filter.event === 'typing') {
        broadcastHandler = callback
      }
      return channel
    }),
    subscribe: vi.fn(() => channel),
    send: vi.fn(),
  }
  return {
    channel,
    /** Simulates an incoming broadcast event with the given inner payload */
    fireTyping: (payload: unknown) => {
      expect(broadcastHandler).not.toBeNull()
      broadcastHandler!({ payload })
    },
  }
}

// -- Tests --------------------------------------------------------------------

describe('useTypingIndicator', () => {
  let mockChannel: ReturnType<typeof createMockChannel>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mockChannel = createMockChannel()
    vi.mocked(supabase.channel).mockReturnValue(mockChannel.channel as never)
  })

  afterEach(() => {
    // Drain any pending setTimeout callbacks to prevent cross-test bleed.
    // Wrapped in act() because timer callbacks may trigger React state updates.
    act(() => {
      vi.runOnlyPendingTimers()
    })
    vi.useRealTimers()
  })

  // -- Empty params: no subscription -----------------------------------------

  it('does not subscribe when channelId is empty', () => {
    renderHook(() => useTypingIndicator('', CURRENT_USER_ID))
    expect(supabase.channel).not.toHaveBeenCalled()
  })

  it('does not subscribe when currentUserId is empty', () => {
    renderHook(() => useTypingIndicator(CHANNEL_ID, ''))
    expect(supabase.channel).not.toHaveBeenCalled()
  })

  // -- Typing event from other user adds to typingUsers ----------------------

  it('adds a remote user to typingUsers on valid typing event', () => {
    const { result } = renderHook(() =>
      useTypingIndicator(CHANNEL_ID, CURRENT_USER_ID),
    )

    act(() => {
      mockChannel.fireTyping({ userId: 'user-other', username: 'Alice' })
    })

    expect(result.current.typingUsers).toEqual([
      { userId: 'user-other', username: 'Alice' },
    ])
  })

  // -- Self-filtering: own events are ignored --------------------------------

  it('ignores typing events from the current user', () => {
    const { result } = renderHook(() =>
      useTypingIndicator(CHANNEL_ID, CURRENT_USER_ID),
    )

    act(() => {
      mockChannel.fireTyping({ userId: CURRENT_USER_ID, username: 'Me' })
    })

    expect(result.current.typingUsers).toEqual([])
  })

  // -- Malformed payload: silently ignored -----------------------------------

  it('ignores malformed typing payloads', () => {
    const { result } = renderHook(() =>
      useTypingIndicator(CHANNEL_ID, CURRENT_USER_ID),
    )

    act(() => {
      mockChannel.fireTyping({ bad: 'data' })
    })

    act(() => {
      mockChannel.fireTyping(null)
    })

    act(() => {
      mockChannel.fireTyping(42)
    })

    expect(result.current.typingUsers).toEqual([])
  })

  // -- Deduplication: same user not added twice ------------------------------

  it('does not create duplicate entries for the same user', () => {
    const { result } = renderHook(() =>
      useTypingIndicator(CHANNEL_ID, CURRENT_USER_ID),
    )

    act(() => {
      mockChannel.fireTyping({ userId: 'user-other', username: 'Alice' })
    })
    act(() => {
      mockChannel.fireTyping({ userId: 'user-other', username: 'Alice' })
    })

    expect(result.current.typingUsers).toHaveLength(1)
    expect(result.current.typingUsers[0]?.userId).toBe('user-other')
  })

  // -- 5-second expiry: user removed after timeout ---------------------------

  it('removes a typing user after 5000ms', () => {
    const { result } = renderHook(() =>
      useTypingIndicator(CHANNEL_ID, CURRENT_USER_ID),
    )

    act(() => {
      mockChannel.fireTyping({ userId: 'user-other', username: 'Alice' })
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

  it('throttles sendTyping to once per 3 seconds', () => {
    const { result } = renderHook(() =>
      useTypingIndicator(CHANNEL_ID, CURRENT_USER_ID),
    )

    // First call goes through
    act(() => {
      result.current.sendTyping('Me')
    })
    expect(mockChannel.channel.send).toHaveBeenCalledOnce()

    // Call within 3 seconds is throttled
    act(() => {
      vi.advanceTimersByTime(2999)
    })
    act(() => {
      result.current.sendTyping('Me')
    })
    expect(mockChannel.channel.send).toHaveBeenCalledOnce()

    // After 3 seconds, the next call goes through
    act(() => {
      vi.advanceTimersByTime(1)
    })
    act(() => {
      result.current.sendTyping('Me')
    })
    expect(mockChannel.channel.send).toHaveBeenCalledTimes(2)
  })

  // -- sendTyping broadcasts correct payload structure -----------------------

  it('sends correct broadcast payload structure', () => {
    const { result } = renderHook(() =>
      useTypingIndicator(CHANNEL_ID, CURRENT_USER_ID),
    )

    act(() => {
      result.current.sendTyping('MyUsername')
    })

    expect(mockChannel.channel.send).toHaveBeenCalledWith({
      type: 'broadcast',
      event: 'typing',
      payload: { userId: CURRENT_USER_ID, username: 'MyUsername' },
    })
  })

  // -- Cleanup: removeChannel on unmount -------------------------------------

  it('calls supabase.removeChannel on unmount', () => {
    const { unmount } = renderHook(() =>
      useTypingIndicator(CHANNEL_ID, CURRENT_USER_ID),
    )

    expect(supabase.removeChannel).not.toHaveBeenCalled()

    unmount()

    expect(supabase.removeChannel).toHaveBeenCalledOnce()
    expect(supabase.removeChannel).toHaveBeenCalledWith(mockChannel.channel)
  })
})
