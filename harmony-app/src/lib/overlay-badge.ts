import { logger } from '@/lib/logger'

/**
 * Renders the Windows taskbar overlay badge (unread count) as PNG bytes.
 *
 * WHY generated at runtime: the overlay shows the live unread count, so it
 * cannot be a static asset. Same canvas approach as use-favicon-badge.ts,
 * but returning bytes because Tauri's setOverlayIcon takes an image, not a
 * DOM <link> href.
 */

const CANVAS_SIZE = 32
// WHY hardcoded: Canvas 2D cannot read CSS variables; matches the system
// red used by use-favicon-badge.ts.
const BADGE_COLOR = '#ff3b30'
const TEXT_COLOR = '#ffffff'
const MAX_DISPLAY_COUNT = 99

function decodeDataUrl(dataUrl: string): Uint8Array | null {
  const base64 = dataUrl.split(',')[1]
  if (base64 === undefined || base64 === '') return null
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

/**
 * Draws a red circle with the (clamped) unread count and returns PNG bytes,
 * or `null` when the canvas is unavailable (logged — background operation,
 * ADR-045: no user-facing feedback).
 */
export function renderOverlayBadgePng(count: number): Uint8Array | null {
  const canvas = document.createElement('canvas')
  canvas.width = CANVAS_SIZE
  canvas.height = CANVAS_SIZE
  const ctx = canvas.getContext('2d')
  if (ctx === null) {
    logger.warn('overlay_badge_canvas_unavailable', {})
    return null
  }

  try {
    const center = CANVAS_SIZE / 2
    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE)
    ctx.beginPath()
    ctx.arc(center, center, center, 0, 2 * Math.PI)
    ctx.fillStyle = BADGE_COLOR
    ctx.fill()

    const label = count > MAX_DISPLAY_COUNT ? `${MAX_DISPLAY_COUNT}+` : String(count)
    ctx.fillStyle = TEXT_COLOR
    // WHY smaller font for wide labels: "99+" must fit inside the circle.
    ctx.font = label.length > 2 ? 'bold 13px sans-serif' : 'bold 18px sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, center, center + 1)

    return decodeDataUrl(canvas.toDataURL('image/png'))
  } catch (err: unknown) {
    logger.warn('overlay_badge_draw_failed', {
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}
