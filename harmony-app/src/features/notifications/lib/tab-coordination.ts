/**
 * Multi-tab focus coordination via the Web Locks API (D6).
 *
 * ONLY the focus lock — per-event claim locks were deliberately cut (they
 * carried cross-tab cooldown incoherence and a silent-sound autoplay hazard).
 * Visible dedup is handled by OS `tag` coalescing in the adapter; sounds play
 * per-tab (today's shipped behavior).
 */

const FOCUS_LOCK_NAME = 'harmony:app-focused'

/**
 * Hold the focus lock while this tab has focus (steal on focus, release on
 * blur). Returns a cleanup function. Mount once in MainLayout.
 */
export function trackFocusLock(): () => void {
  if (typeof navigator === 'undefined' || navigator.locks === undefined) {
    // WHY no-op fallback: without Web Locks, isAnyTabFocused() degrades to
    // document.hasFocus() — nothing to track. (Tauri is single-window and
    // takes this path too.)
    return () => {}
  }

  let releaseLock: (() => void) | null = null

  function acquire() {
    if (releaseLock !== null) return
    // WHY steal: only one tab has OS focus at a time — a stale holder (e.g. a
    // tab that missed its blur event) must not shadow the truly focused tab.
    void navigator.locks
      .request(FOCUS_LOCK_NAME, { mode: 'exclusive', steal: true }, () => {
        return new Promise<void>((resolve) => {
          releaseLock = resolve
        })
      })
      .catch(() => {
        // WHY swallow: a stolen/aborted lock is the expected steal-on-focus
        // mechanic, not an error.
        releaseLock = null
      })
  }

  function release() {
    if (releaseLock !== null) {
      releaseLock()
      releaseLock = null
    }
  }

  if (document.hasFocus()) acquire()
  window.addEventListener('focus', acquire)
  window.addEventListener('blur', release)

  return () => {
    window.removeEventListener('focus', acquire)
    window.removeEventListener('blur', release)
    release()
  }
}

/** True if ANY same-origin tab currently holds the focus lock. */
export async function isAnyTabFocused(): Promise<boolean> {
  if (typeof navigator === 'undefined' || navigator.locks === undefined) {
    return document.hasFocus()
  }
  const state = await navigator.locks.query()
  return (state.held ?? []).some((lock) => lock.name === FOCUS_LOCK_NAME)
}
