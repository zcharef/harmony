import { describe, expect, it } from 'vitest'
import {
  CHAT_DEFAULT_DM,
  CHAT_DEFAULT_SERVER,
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX_LEFT,
  SIDEBAR_MAX_MEMBERS,
  SIDEBAR_MIN,
} from './sidebar-sizes'

// WHY: jsdom has no layout engine, so a percentage panel never resolves to a real
// px width in a unit test. We assert the sizing invariants at the constant level
// instead — the deterministic guard that both sidebars open at their minimum width
// and that any future default edit keeps each panel row summing to 100%.

// WHY: sizes are percentage strings ("15%") typed by react-resizable-panels. Parse
// the numeric part to check arithmetic invariants.
function pct(size: string): number {
  const value = Number.parseFloat(size)
  expect(Number.isNaN(value)).toBe(false)
  return value
}

describe('sidebar sizing constants', () => {
  it('opens both sidebars at their minimum width (the feature)', () => {
    // Left sidebar and members sidebar share SIDEBAR_DEFAULT, which is SIDEBAR_MIN.
    expect(SIDEBAR_DEFAULT).toBe(SIDEBAR_MIN)
    expect(SIDEBAR_DEFAULT).toBe('15%')
  })

  it('keeps the resize range unchanged (resizability preserved)', () => {
    // Lowering the default must not touch min/max — users can still drag wider.
    expect(SIDEBAR_MIN).toBe('15%')
    expect(SIDEBAR_MAX_LEFT).toBe('30%')
    expect(SIDEBAR_MAX_MEMBERS).toBe('25%')
    expect(pct(SIDEBAR_MIN)).toBeLessThan(pct(SIDEBAR_MAX_LEFT))
    expect(pct(SIDEBAR_MIN)).toBeLessThan(pct(SIDEBAR_MAX_MEMBERS))
  })

  it('sums the server-view row to 100% (left + chat + members)', () => {
    expect(pct(SIDEBAR_DEFAULT) + pct(CHAT_DEFAULT_SERVER) + pct(SIDEBAR_DEFAULT)).toBe(100)
  })

  it('sums the DM-view row to 100% (left + chat, no members panel)', () => {
    expect(pct(SIDEBAR_DEFAULT) + pct(CHAT_DEFAULT_DM)).toBe(100)
  })
})
