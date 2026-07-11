import { create } from 'zustand'
import type { PlanGateError } from '@/lib/plan-gate'

interface UpgradeModalState {
  /** The plan-gate rejection currently on screen, or null when closed. */
  gate: PlanGateError | null
  open: (gate: PlanGateError) => void
  close: () => void
}

/**
 * WHY a zustand store: the modal is opened from OUTSIDE React (the
 * TanStack mutation cache's global onError) and read by one component
 * mounted at the app root. Zustand stores are callable from plain
 * functions via getState() — no context plumbing.
 */
export const useUpgradeModalStore = create<UpgradeModalState>()((set) => ({
  gate: null,
  open: (gate) => set({ gate }),
  close: () => set({ gate: null }),
}))

/** Imperative opener for non-React call sites (mutation cache interceptor). */
export function openUpgradeModal(gate: PlanGateError) {
  useUpgradeModalStore.getState().open(gate)
}
