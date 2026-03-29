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

/**
 * Opens a URL in the system browser.
 *
 * WHY: Tauri blocks `<a target="_blank">` — links do nothing unless opened via
 * the plugin-opener API. This helper unifies the pattern for both platforms.
 */
export async function openExternalUrl(url: string): Promise<void> {
  if (isTauri()) {
    const { openUrl } = await import('@tauri-apps/plugin-opener')
    await openUrl(url)
  } else {
    window.open(url, '_blank', 'noopener,noreferrer')
  }
}
