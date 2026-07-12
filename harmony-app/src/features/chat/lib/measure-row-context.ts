import { createContext } from 'react'

/**
 * Re-measures the virtual row that owns the given element. Provided by the
 * chat-area virtualizer; consumed by inline media (`EmbeddedImage`) so a
 * fallback-reserved image can correct its row's measured height the moment its
 * real dimensions arrive, instead of waiting a frame for the ResizeObserver.
 *
 * `null` outside a virtualized list (e.g. in isolated component tests) — the
 * consumer no-ops.
 */
export type MeasureRow = (node: Element) => void

export const MeasureRowContext = createContext<MeasureRow | null>(null)
