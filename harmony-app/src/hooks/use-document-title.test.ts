import { renderHook } from '@testing-library/react'
import { act } from 'react'
import { useUnreadStore } from '@/features/channels'
import { useDocumentTitle } from './use-document-title'

describe('useDocumentTitle', () => {
  beforeEach(() => {
    useUnreadStore.setState({ counts: {}, mentionCounts: {} })
  })

  it('shows the base title with no unreads', () => {
    renderHook(() => useDocumentTitle())

    expect(document.title).toBe('Harmony')
  })

  it('shows (N) for plain unreads', () => {
    renderHook(() => useDocumentTitle())

    act(() => {
      useUnreadStore.getState().sync({ 'ch-1': 3, 'ch-2': 2 })
    })

    expect(document.title).toBe('(5) Harmony')
  })

  it('shows (@M) when any mention is pending — mentions outrank unreads', () => {
    renderHook(() => useDocumentTitle())

    act(() => {
      useUnreadStore.getState().sync({ 'ch-1': 12 }, { 'ch-1': 2 })
    })

    expect(document.title).toBe('(@2) Harmony')
  })

  it('falls back to (N) when mentions clear but unreads remain (live, no refresh)', () => {
    renderHook(() => useDocumentTitle())

    act(() => {
      useUnreadStore.getState().sync({ 'ch-1': 12, 'ch-2': 1 }, { 'ch-1': 2 })
    })
    act(() => {
      useUnreadStore.getState().clear('ch-1')
    })

    expect(document.title).toBe('(1) Harmony')
  })
})
