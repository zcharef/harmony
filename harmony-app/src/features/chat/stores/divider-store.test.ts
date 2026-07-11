import { beforeEach, describe, expect, it } from 'vitest'
import { useDividerStore } from './divider-store'

// Reset the singleton store between tests.
beforeEach(() => {
  useDividerStore.setState({ anchors: {} })
})

describe('divider-store', () => {
  it('freezes an anchor for a channel', () => {
    useDividerStore.getState().freeze('c1', '2026-01-01T00:00:00Z')
    expect(useDividerStore.getState().anchors.c1).toEqual({ anchorAt: '2026-01-01T00:00:00Z' })
  })

  it('is idempotent — a second freeze never overwrites the frozen boundary', () => {
    const { freeze } = useDividerStore.getState()
    freeze('c1', '2026-01-01T00:00:00Z')
    // Simulates the read-state query re-resolving to an advanced boundary after
    // mark-read: the divider MUST stay pinned to the original open-time anchor.
    freeze('c1', '2026-12-31T23:59:59Z')
    expect(useDividerStore.getState().anchors.c1).toEqual({ anchorAt: '2026-01-01T00:00:00Z' })
  })

  it('preserves a null anchor (never-read) as frozen — not "unset"', () => {
    const { freeze } = useDividerStore.getState()
    freeze('c1', null)
    freeze('c1', '2026-01-01T00:00:00Z')
    expect(useDividerStore.getState().anchors.c1).toEqual({ anchorAt: null })
  })

  it('clears the anchor on channel switch so re-entry re-freezes', () => {
    const { freeze, clear } = useDividerStore.getState()
    freeze('c1', '2026-01-01T00:00:00Z')
    clear('c1')
    expect(useDividerStore.getState().anchors.c1).toBeUndefined()
    // Re-entry freezes a fresh (advanced) boundary.
    freeze('c1', '2026-06-01T00:00:00Z')
    expect(useDividerStore.getState().anchors.c1).toEqual({ anchorAt: '2026-06-01T00:00:00Z' })
  })

  it('keeps per-channel anchors independent', () => {
    const { freeze, clear } = useDividerStore.getState()
    freeze('c1', '2026-01-01T00:00:00Z')
    freeze('c2', '2026-02-01T00:00:00Z')
    clear('c1')
    expect(useDividerStore.getState().anchors.c1).toBeUndefined()
    expect(useDividerStore.getState().anchors.c2).toEqual({ anchorAt: '2026-02-01T00:00:00Z' })
  })
})
