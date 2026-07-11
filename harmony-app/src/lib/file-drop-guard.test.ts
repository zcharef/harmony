import { installFileDropGuard } from './file-drop-guard'

/**
 * Pins the window-level drop guard: a file dropped anywhere outside the
 * composer drop zone must NOT trigger the webview's default behavior
 * (navigating to file://…). Regression guard for dragDropEnabled: false.
 */
describe('installFileDropGuard', () => {
  function dispatchCancelable(target: Window, type: string): Event {
    const event = new Event(type, { bubbles: true, cancelable: true })
    target.dispatchEvent(event)
    return event
  }

  it('prevents the default action of window-level drop events', () => {
    installFileDropGuard(window)

    const drop = dispatchCancelable(window, 'drop')
    expect(drop.defaultPrevented).toBe(true)
  })

  it('prevents the default action of window-level dragover events', () => {
    installFileDropGuard(window)

    const dragOver = dispatchCancelable(window, 'dragover')
    expect(dragOver.defaultPrevented).toBe(true)
  })
})
