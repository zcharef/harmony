/**
 * Platform detection for dual web/desktop deployment.
 *
 * WHY: The same React codebase runs as a web app (Vite build) and a Tauri
 * desktop app. E2EE features require Tauri invoke() commands that only exist
 * in the desktop context. All crypto calls must be behind isTauri() guards.
 */

/** Returns true when running inside the Tauri desktop shell. */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}
