// WHY (E3): Single source of truth for the horizontal panel sizes in MainLayout.
// Both sidebars default to their minimum width so they open compact (Discord-like)
// while staying resizable — users can still drag them wider (min/max untouched).
// Percentages of the resizable Group (viewport minus the fixed 72px server-nav rail).
// Each row sums to 100%: server view = SIDEBAR_DEFAULT + CHAT_DEFAULT_SERVER +
// SIDEBAR_DEFAULT; DM view = SIDEBAR_DEFAULT + CHAT_DEFAULT_DM (no members panel).
// Kept in a standalone module so the invariant test imports the constants without
// pulling the whole MainLayout graph (Vite-define globals) into the test runner.
export const SIDEBAR_MIN = '15%'
export const SIDEBAR_MAX_LEFT = '30%'
export const SIDEBAR_MAX_MEMBERS = '25%'
// WHY the default is its own literal (not `= SIDEBAR_MIN`): the "sidebars open at
// their minimum width" invariant is then enforced by a real test assertion
// (SIDEBAR_DEFAULT === SIDEBAR_MIN) instead of a tautology, and it stays a distinct
// export rather than an alias.
export const SIDEBAR_DEFAULT = '15%' // MUST equal SIDEBAR_MIN — guarded by sidebar-sizes.test.ts
export const CHAT_MIN = '30%'
export const CHAT_DEFAULT_SERVER = '70%'
export const CHAT_DEFAULT_DM = '85%'
