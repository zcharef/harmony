import { renderHook } from '@testing-library/react'
import { act } from 'react'
import { useTotalMentions, useTotalUnread, useUnreadStore } from './unread-store'

describe('unread-store mentions', () => {
  beforeEach(() => {
    useUnreadStore.setState({ counts: {}, mentionCounts: {} })
  })

  it('incrementMention increments only the mention map', () => {
    act(() => {
      useUnreadStore.getState().incrementMention('ch-1')
      useUnreadStore.getState().incrementMention('ch-1')
    })

    expect(useUnreadStore.getState().mentionCounts['ch-1']).toBe(2)
    expect(useUnreadStore.getState().counts['ch-1']).toBeUndefined()
  })

  it('clear zeroes BOTH maps for the channel', () => {
    act(() => {
      useUnreadStore.getState().increment('ch-1')
      useUnreadStore.getState().incrementMention('ch-1')
      useUnreadStore.getState().incrementMention('ch-2')
      useUnreadStore.getState().clear('ch-1')
    })

    expect(useUnreadStore.getState().counts['ch-1']).toBe(0)
    expect(useUnreadStore.getState().mentionCounts['ch-1']).toBe(0)
    // WHY: clear is per-channel — other channels keep their counts.
    expect(useUnreadStore.getState().mentionCounts['ch-2']).toBe(1)
  })

  it('sync full-replaces BOTH maps (reconnect self-healing)', () => {
    act(() => {
      useUnreadStore.getState().increment('stale')
      useUnreadStore.getState().incrementMention('stale')
      useUnreadStore.getState().sync({ 'ch-1': 5 }, { 'ch-1': 2 })
    })

    expect(useUnreadStore.getState().counts).toEqual({ 'ch-1': 5 })
    expect(useUnreadStore.getState().mentionCounts).toEqual({ 'ch-1': 2 })
  })

  it('sync without a mentions map resets mentions to empty (old API instances)', () => {
    act(() => {
      useUnreadStore.getState().incrementMention('stale')
      useUnreadStore.getState().sync({ 'ch-1': 5 })
    })

    expect(useUnreadStore.getState().mentionCounts).toEqual({})
  })

  it('useTotalMentions sums across channels and updates live', () => {
    const { result } = renderHook(() => useTotalMentions())
    expect(result.current).toBe(0)

    act(() => {
      useUnreadStore.getState().sync({ 'ch-1': 4, 'ch-2': 1 }, { 'ch-1': 2, 'ch-2': 1 })
    })
    expect(result.current).toBe(3)

    act(() => {
      useUnreadStore.getState().clear('ch-1')
    })
    expect(result.current).toBe(1)
  })

  it('useTotalUnread is unaffected by mention increments', () => {
    const { result } = renderHook(() => useTotalUnread())

    act(() => {
      useUnreadStore.getState().incrementMention('ch-1')
    })

    expect(result.current).toBe(0)
  })
})
