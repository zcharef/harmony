import { renderHook } from '@testing-library/react'
import { act } from 'react'
import { vi } from 'vitest'
import { SSE_EVENT_PREFIX } from '@/hooks/use-server-event'
import { useUnreadStore } from '../stores/unread-store'
import { useUnreadSync } from './use-unread-sync'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const { logger } = await import('@/lib/logger')

function fireUnreadSync(payload: unknown) {
  act(() => {
    window.dispatchEvent(new CustomEvent(`${SSE_EVENT_PREFIX}unread.sync`, { detail: payload }))
  })
}

describe('useUnreadSync mentions hydration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useUnreadStore.setState({ counts: {}, mentionCounts: {} })
  })

  it('hydrates BOTH maps from the snapshot (connect/reconnect self-healing)', () => {
    renderHook(() => useUnreadSync('user-me'))
    act(() => {
      useUnreadStore.getState().incrementMention('stale-channel')
    })

    fireUnreadSync({ channels: { 'ch-1': 7, 'ch-2': 1 }, mentions: { 'ch-1': 3 } })

    expect(useUnreadStore.getState().counts).toEqual({ 'ch-1': 7, 'ch-2': 1 })
    expect(useUnreadStore.getState().mentionCounts).toEqual({ 'ch-1': 3 })
  })

  it('defaults mentions to empty when the snapshot omits the map (old API instances)', () => {
    renderHook(() => useUnreadSync('user-me'))
    act(() => {
      useUnreadStore.getState().incrementMention('stale-channel')
    })

    fireUnreadSync({ channels: { 'ch-1': 7 } })

    expect(useUnreadStore.getState().mentionCounts).toEqual({})
  })

  it('warns and changes nothing on a malformed snapshot (ADR-027)', () => {
    renderHook(() => useUnreadSync('user-me'))

    fireUnreadSync({ channels: { 'ch-1': 'not-a-number' } })

    expect(logger.warn).toHaveBeenCalledWith(
      'malformed_unread_sync_event',
      expect.objectContaining({ error: expect.any(String) }),
    )
    expect(useUnreadStore.getState().counts).toEqual({})
  })

  it('ignores snapshots when userId is null (not signed in)', () => {
    renderHook(() => useUnreadSync(null))

    fireUnreadSync({ channels: { 'ch-1': 7 }, mentions: { 'ch-1': 3 } })

    expect(useUnreadStore.getState().counts).toEqual({})
    expect(useUnreadStore.getState().mentionCounts).toEqual({})
  })
})
