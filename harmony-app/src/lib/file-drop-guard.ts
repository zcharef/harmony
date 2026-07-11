/**
 * Window-level guard against the browser's default drop behavior.
 *
 * WHY: with `dragDropEnabled: false` in tauri.conf.json (needed so the
 * composer's HTML5 onDrop fires on desktop), nothing intercepts drops that
 * land OUTSIDE the composer drop zone — sidebar, header, member list, or the
 * composer itself when attachments are disabled. Chromium/WebKit then
 * navigates the webview to the dropped file (file://…), replacing the running
 * app with no URL bar to recover from.
 *
 * The composer path is unaffected: React handlers run during bubbling before
 * these window listeners and already call preventDefault themselves.
 */
export function installFileDropGuard(target: Window = window): void {
  target.addEventListener('dragover', (event) => {
    event.preventDefault()
  })
  target.addEventListener('drop', (event) => {
    event.preventDefault()
  })
}
